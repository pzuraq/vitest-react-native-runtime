package com.nativeharness

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Choreographer
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.TextView
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.bridge.WritableMap
import com.facebook.react.module.annotations.ReactModule
import java.lang.ref.WeakReference
import java.util.LinkedList
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

@ReactModule(name = NativeHarnessModule.NAME)
class NativeHarnessModule(
  reactContext: ReactApplicationContext,
) : NativeNativeHarnessSpec(reactContext) {

  companion object {
    const val NAME = "NativeHarness"
    private const val TAP_DURATION_MS = 50L
    private const val EVENT_DELAY_MS = 20L
    private val viewRegistry = ConcurrentHashMap<String, WeakReference<View>>()

    fun registerView(view: View): String {
      val id = UUID.randomUUID().toString()
      viewRegistry[id] = WeakReference(view)
      return id
    }

    fun getView(id: String): View? = viewRegistry[id]?.get()
  }

  private val mainHandler = Handler(Looper.getMainLooper())

  override fun getName(): String = NAME

  // ── Queries (async, dispatched to UI thread) ─────────────────────

  override fun queryByTestId(testId: String, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      val root = currentActivity?.window?.decorView
      if (root == null) { promise.resolve(null); return@runOnUiThread }
      val view = bfs(root) { getTestId(it) == testId }
      promise.resolve(view?.let { viewInfoMap(it) })
    }
  }

  override fun queryAllByTestId(testId: String, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      val root = currentActivity?.window?.decorView
      if (root == null) { promise.resolve(Arguments.createArray()); return@runOnUiThread }
      val views = bfsAll(root) { getTestId(it) == testId }
      val arr = Arguments.createArray()
      views.forEach { arr.pushMap(viewInfoMap(it)) }
      promise.resolve(arr)
    }
  }

  override fun queryByText(text: String, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      val root = currentActivity?.window?.decorView
      if (root == null) { promise.resolve(null); return@runOnUiThread }
      val view = bfs(root) { readText(it)?.contains(text) == true }
      promise.resolve(view?.let { viewInfoMap(it) })
    }
  }

  override fun queryAllByText(text: String, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      val root = currentActivity?.window?.decorView
      if (root == null) { promise.resolve(Arguments.createArray()); return@runOnUiThread }
      val views = bfsAll(root) { readText(it)?.contains(text) == true }
      val arr = Arguments.createArray()
      views.forEach { arr.pushMap(viewInfoMap(it)) }
      promise.resolve(arr)
    }
  }

  override fun getText(nativeId: String, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      val view = getView(nativeId)
      promise.resolve(view?.let { readText(it) })
    }
  }

  override fun isVisible(nativeId: String, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      val view = getView(nativeId)
      promise.resolve(view != null && view.isShown && view.alpha > 0.01f)
    }
  }

  override fun dumpViewTree(promise: Promise) {
    UiThreadUtil.runOnUiThread {
      val root = currentActivity?.window?.decorView
      promise.resolve(root?.let { buildTreeNode(it) })
    }
  }

  // ── Touch Synthesis ───────────────────────────────────────────────

  override fun simulatePress(nativeId: String, x: Double, y: Double, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      val activity = currentActivity ?: run { promise.resolve(null); return@runOnUiThread }
      val root = activity.window.decorView
      val density = root.resources.displayMetrics.density

      var targetX = x
      var targetY = y

      if (nativeId.isNotEmpty()) {
        val view = getView(nativeId)
        if (view != null) {
          val loc = IntArray(2)
          view.getLocationOnScreen(loc)
          targetX = (loc[0] + view.width / 2.0) / density
          targetY = (loc[1] + view.height / 2.0) / density
        }
      }

      val pxX = (targetX * density).toFloat()
      val pxY = (targetY * density).toFloat()
      val downTime = SystemClock.uptimeMillis()

      val downEvent = MotionEvent.obtain(downTime, downTime, MotionEvent.ACTION_DOWN, pxX, pxY, 0)
      try { root.dispatchTouchEvent(downEvent) } finally { downEvent.recycle() }

      mainHandler.postDelayed({
        val upTime = SystemClock.uptimeMillis()
        val upEvent = MotionEvent.obtain(downTime, upTime, MotionEvent.ACTION_UP, pxX, pxY, 0)
        try { root.dispatchTouchEvent(upEvent) } finally { upEvent.recycle() }

        // Short delay for React Native to process the touch event dispatch,
        // then resolve. JS side handles remaining sync via setImmediate yields.
        mainHandler.postDelayed({ promise.resolve(null) }, EVENT_DELAY_MS)
      }, TAP_DURATION_MS)
    }
  }

  // ── Text Input ────────────────────────────────────────────────────

  override fun typeChar(character: String, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      val focused = currentActivity?.currentFocus
      if (focused is EditText) {
        val start = focused.selectionStart
        val end = focused.selectionEnd
        focused.text.replace(start, end, character)
      }
      mainHandler.postDelayed({ promise.resolve(null) }, EVENT_DELAY_MS)
    }
  }

  override fun typeIntoView(nativeId: String, text: String, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      val view = getView(nativeId)
      if (view != null) {
        // Tap to focus the view first
        val activity = currentActivity ?: run { promise.resolve(null); return@runOnUiThread }
        val root = activity.window.decorView
        val density = root.resources.displayMetrics.density
        val loc = IntArray(2)
        view.getLocationOnScreen(loc)
        val cx = (loc[0] + view.width / 2.0f)
        val cy = (loc[1] + view.height / 2.0f)
        val downTime = SystemClock.uptimeMillis()

        val downEvent = MotionEvent.obtain(downTime, downTime, MotionEvent.ACTION_DOWN, cx, cy, 0)
        try { root.dispatchTouchEvent(downEvent) } finally { downEvent.recycle() }
        val upEvent = MotionEvent.obtain(downTime, downTime + 30, MotionEvent.ACTION_UP, cx, cy, 0)
        try { root.dispatchTouchEvent(upEvent) } finally { upEvent.recycle() }

        // After focus, insert text
        mainHandler.postDelayed({
          val focused = activity.currentFocus
          if (focused is EditText) {
            val start = focused.selectionStart
            val end = focused.selectionEnd
            focused.text.replace(start, end, text)
          }
          mainHandler.postDelayed({ promise.resolve(null) }, EVENT_DELAY_MS)
        }, 100)
      } else {
        promise.resolve(null)
      }
    }
  }

  // ── Flush UI Queue ─────────────────────────────────────────────────

  override fun flushUIQueue(promise: Promise) {
    // Wait for the next Choreographer frame, which ensures EventBeatManager
    // has ticked and flushed any pending events to JS.
    UiThreadUtil.runOnUiThread {
      Choreographer.getInstance().postFrameCallback {
        promise.resolve(null)
      }
    }
  }

  // ── View Info ─────────────────────────────────────────────────────

  private fun viewInfoMap(view: View): WritableMap {
    val density = view.resources.displayMetrics.density
    val loc = IntArray(2)
    view.getLocationOnScreen(loc)
    val nativeId = registerView(view)
    return Arguments.createMap().apply {
      putString("nativeId", nativeId)
      putDouble("x", loc[0].toDouble() / density)
      putDouble("y", loc[1].toDouble() / density)
      putDouble("width", view.width.toDouble() / density)
      putDouble("height", view.height.toDouble() / density)
    }
  }

  // ── TestID Resolution ─────────────────────────────────────────────

  private var reactTestIdResId: Int = -1

  private fun getReactTestIdResId(): Int {
    if (reactTestIdResId != -1) return reactTestIdResId
    val ctx = currentActivity ?: return 0
    var resId = ctx.resources.getIdentifier("react_test_id", "id", ctx.packageName)
    if (resId == 0) {
      try {
        val clazz = Class.forName("com.facebook.react.R\$id")
        resId = clazz.getDeclaredField("react_test_id").getInt(null)
      } catch (_: Exception) {}
    }
    reactTestIdResId = resId
    return resId
  }

  private fun getTestId(view: View): String? {
    val resId = getReactTestIdResId()
    if (resId != 0) {
      val tag = view.getTag(resId)
      if (tag is String) return tag
    }
    // Fallback: check view.tag directly (some RN versions use this)
    val tag = view.tag
    if (tag is String) return tag
    return null
  }

  // ── BFS Helpers ───────────────────────────────────────────────────

  private fun bfs(root: View, predicate: (View) -> Boolean): View? {
    val queue = LinkedList<View>()
    queue.add(root)
    while (queue.isNotEmpty()) {
      val v = queue.poll() ?: continue
      if (predicate(v)) return v
      if (v is ViewGroup) for (i in 0 until v.childCount) queue.add(v.getChildAt(i))
    }
    return null
  }

  private fun bfsAll(root: View, predicate: (View) -> Boolean): List<View> {
    val results = mutableListOf<View>()
    val queue = LinkedList<View>()
    queue.add(root)
    while (queue.isNotEmpty()) {
      val v = queue.poll() ?: continue
      if (predicate(v)) results.add(v)
      if (v is ViewGroup) for (i in 0 until v.childCount) queue.add(v.getChildAt(i))
    }
    return results
  }

  // ── Text Reading ──────────────────────────────────────────────────

  private fun readText(view: View): String? {
    if (view is TextView) return view.text?.toString()
    val texts = mutableListOf<String>()
    collectText(view, texts)
    return if (texts.isNotEmpty()) texts.joinToString(" ") else null
  }

  private fun collectText(view: View, texts: MutableList<String>) {
    if (view is TextView) {
      view.text?.toString()?.takeIf { it.isNotEmpty() }?.let { texts.add(it) }
      return
    }
    if (view is ViewGroup) for (i in 0 until view.childCount) collectText(view.getChildAt(i), texts)
  }

  // ── View Tree Dump ────────────────────────────────────────────────

  private fun buildTreeNode(view: View, depth: Int = 0): WritableMap? {
    if (depth > 30) return null
    val className = view.javaClass.simpleName
    val type = when (className) {
      "ReactViewGroup" -> "View"
      "ReactTextView" -> "Text"
      "ReactEditText" -> "TextInput"
      "ReactScrollView", "ReactHorizontalScrollView" -> "ScrollView"
      else -> className
    }

    val children = Arguments.createArray()
    if (view is ViewGroup) {
      for (i in 0 until view.childCount) {
        buildTreeNode(view.getChildAt(i), depth + 1)?.let { children.pushMap(it) }
      }
    }

    val testId = getTestId(view)
    val text = if (view is TextView) view.text?.toString() else null
    if (children.size() == 0 && testId == null && text == null) return null

    val loc = IntArray(2)
    view.getLocationOnScreen(loc)
    return Arguments.createMap().apply {
      putString("type", type)
      putBoolean("visible", view.isShown && view.alpha > 0.01f)
      putMap("frame", Arguments.createMap().apply {
        putDouble("x", loc[0].toDouble())
        putDouble("y", loc[1].toDouble())
        putDouble("width", view.width.toDouble())
        putDouble("height", view.height.toDouble())
      })
      putArray("children", children)
      testId?.let { putString("testID", it) }
      text?.let { putString("text", it) }
    }
  }
}
