#import "NativeHarness.h"
#import <React/RCTLog.h>
#import <React/RCTUtils.h>
#import <UIKit/UIKit.h>

// Import the auto-generated Swift header for HammerBridge access
#if __has_include(<NativeHarness/NativeHarness-Swift.h>)
#import <NativeHarness/NativeHarness-Swift.h>
#else
#import "NativeHarness-Swift.h"
#endif

static NSMapTable<NSString *, UIView *> *_viewRegistry;

@implementation NativeHarness

+ (void)initialize {
  if (self == [NativeHarness class]) {
    _viewRegistry = [NSMapTable strongToWeakObjectsMapTable];
  }
}

#pragma mark - Window Access

+ (UIWindow *)activeWindow {
  if (@available(iOS 15.0, *)) {
    UIWindow *firstWindow = nil;
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
      if ([scene isKindOfClass:[UIWindowScene class]]) {
        UIWindowScene *windowScene = (UIWindowScene *)scene;
        for (UIWindow *window in windowScene.windows) {
          if (window.isKeyWindow) return window;
          if (!firstWindow) firstWindow = window;
        }
      }
    }
    if (firstWindow) return firstWindow;
  }
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  UIWindow *key = UIApplication.sharedApplication.keyWindow;
  if (key) return key;
  return UIApplication.sharedApplication.windows.firstObject;
#pragma clang diagnostic pop
}

#pragma mark - View Registry

+ (NSString *)registerView:(UIView *)view {
  NSString *nativeId = [[NSUUID UUID] UUIDString];
  [_viewRegistry setObject:view forKey:nativeId];
  return nativeId;
}

+ (UIView *)viewForId:(NSString *)nativeId {
  return [_viewRegistry objectForKey:nativeId];
}

#pragma mark - View Queries

+ (UIView *)findFirstView:(UIView *)root matching:(BOOL (^)(UIView *))predicate {
  NSMutableArray<UIView *> *queue = [NSMutableArray arrayWithObject:root];
  while (queue.count > 0) {
    UIView *view = queue.firstObject;
    [queue removeObjectAtIndex:0];
    if (predicate(view)) return view;
    [queue addObjectsFromArray:view.subviews];
  }
  return nil;
}

+ (NSArray<UIView *> *)findAllViews:(UIView *)root matching:(BOOL (^)(UIView *))predicate {
  NSMutableArray<UIView *> *results = [NSMutableArray new];
  NSMutableArray<UIView *> *queue = [NSMutableArray arrayWithObject:root];
  while (queue.count > 0) {
    UIView *view = queue.firstObject;
    [queue removeObjectAtIndex:0];
    if (predicate(view)) [results addObject:view];
    [queue addObjectsFromArray:view.subviews];
  }
  return results;
}

+ (NSDictionary *)viewInfoForView:(UIView *)view {
  UIWindow *window = [self activeWindow];
  CGRect frame = [view convertRect:view.bounds toView:window];
  NSString *nativeId = [self registerView:view];
  return @{
    @"nativeId": nativeId,
    @"x": @(frame.origin.x),
    @"y": @(frame.origin.y),
    @"width": @(frame.size.width),
    @"height": @(frame.size.height),
  };
}

+ (NSString *)readText:(UIView *)view {
  if ([view isKindOfClass:[UILabel class]]) return ((UILabel *)view).text;
  if ([view isKindOfClass:[UITextField class]]) return ((UITextField *)view).text;
  if ([view isKindOfClass:[UITextView class]]) return ((UITextView *)view).text;
  NSMutableArray *texts = [NSMutableArray new];
  for (UIView *sub in view.subviews) {
    NSString *t = [self readText:sub];
    if (t.length > 0) [texts addObject:t];
  }
  return texts.count > 0 ? [texts componentsJoinedByString:@" "] : nil;
}

#pragma mark - Async Query API

- (void)queryByTestId:(NSString *)testId
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    UIWindow *window = [NativeHarness activeWindow];
    if (!window) { resolve([NSNull null]); return; }
    UIView *view = [NativeHarness findFirstView:window matching:^BOOL(UIView *v) {
      return [v.accessibilityIdentifier isEqualToString:testId];
    }];
    resolve(view ? [NativeHarness viewInfoForView:view] : [NSNull null]);
  });
}

- (void)queryAllByTestId:(NSString *)testId
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    UIWindow *window = [NativeHarness activeWindow];
    if (!window) { resolve(@[]); return; }
    NSArray<UIView *> *views = [NativeHarness findAllViews:window matching:^BOOL(UIView *v) {
      return [v.accessibilityIdentifier isEqualToString:testId];
    }];
    NSMutableArray *infos = [NSMutableArray new];
    for (UIView *v in views) [infos addObject:[NativeHarness viewInfoForView:v]];
    resolve(infos);
  });
}

- (void)queryByText:(NSString *)text
            resolve:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    UIWindow *window = [NativeHarness activeWindow];
    if (!window) { resolve([NSNull null]); return; }
    UIView *view = [NativeHarness findFirstView:window matching:^BOOL(UIView *v) {
      NSString *t = [NativeHarness readText:v];
      return t && [t containsString:text];
    }];
    resolve(view ? [NativeHarness viewInfoForView:view] : [NSNull null]);
  });
}

- (void)queryAllByText:(NSString *)text
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    UIWindow *window = [NativeHarness activeWindow];
    if (!window) { resolve(@[]); return; }
    NSArray<UIView *> *views = [NativeHarness findAllViews:window matching:^BOOL(UIView *v) {
      NSString *t = [NativeHarness readText:v];
      return t && [t containsString:text];
    }];
    NSMutableArray *infos = [NSMutableArray new];
    for (UIView *v in views) [infos addObject:[NativeHarness viewInfoForView:v]];
    resolve(infos);
  });
}

- (void)getText:(NSString *)nativeId
        resolve:(RCTPromiseResolveBlock)resolve
         reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    UIView *view = [NativeHarness viewForId:nativeId];
    resolve(view ? ([NativeHarness readText:view] ?: [NSNull null]) : [NSNull null]);
  });
}

- (void)isVisible:(NSString *)nativeId
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    UIView *view = [NativeHarness viewForId:nativeId];
    resolve(@(view && !view.isHidden && view.alpha > 0.01 && view.window != nil));
  });
}

- (void)dumpViewTree:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    UIWindow *window = [NativeHarness activeWindow];
    resolve(window ? [NativeHarness buildTreeNode:window] : [NSNull null]);
  });
}

#pragma mark - View Tree

+ (NSDictionary *)buildTreeNode:(UIView *)view {
  return [self buildTreeNode:view depth:0 maxDepth:30];
}

+ (NSDictionary *)buildTreeNode:(UIView *)view depth:(int)depth maxDepth:(int)maxDepth {
  if (depth > maxDepth) return nil;
  NSString *type = NSStringFromClass([view class]);
  if ([type hasPrefix:@"RCT"]) type = [type substringFromIndex:3];

  NSMutableArray *children = [NSMutableArray new];
  for (UIView *sub in view.subviews) {
    NSDictionary *child = [self buildTreeNode:sub depth:depth + 1 maxDepth:maxDepth];
    if (child) [children addObject:child];
  }

  NSString *testID = view.accessibilityIdentifier;
  NSString *text = nil;
  if ([view isKindOfClass:[UILabel class]]) text = ((UILabel *)view).text;
  if ([view isKindOfClass:[UITextField class]]) text = ((UITextField *)view).text;

  BOOL isLeaf = children.count == 0;
  if (isLeaf && !testID && !text) return nil;

  CGRect frame = [view convertRect:view.bounds toView:nil];
  NSMutableDictionary *node = [@{
    @"type": type,
    @"visible": @(!view.isHidden && view.alpha > 0.01),
    @"frame": @{
      @"x": @(frame.origin.x),
      @"y": @(frame.origin.y),
      @"width": @(frame.size.width),
      @"height": @(frame.size.height),
    },
    @"children": children,
  } mutableCopy];
  if (testID) node[@"testID"] = testID;
  if (text) node[@"text"] = text;
  return node;
}

#pragma mark - Touch Synthesis (via Hammer)

- (void)simulatePress:(NSString *)nativeId
                    x:(double)x
                    y:(double)y
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    CGPoint point = CGPointMake(x, y);
    if (nativeId && nativeId.length > 0) {
      UIView *view = [NativeHarness viewForId:nativeId];
      if (view && view.window) {
        CGRect frameInWindow = [view convertRect:view.bounds toView:view.window];
        point = CGPointMake(CGRectGetMidX(frameInWindow), CGRectGetMidY(frameInWindow));
      }
    }
    UIWindow *window = [NativeHarness activeWindow];
    if (!window) {
      reject(@"NO_WINDOW", @"No active window", nil);
      return;
    }
    [HammerBridge tapAt:point in:window completion:^(NSError *error) {
      if (error) {
        reject(@"TAP_FAILED", error.localizedDescription, error);
      } else {
        resolve(nil);
      }
    }];
  });
}

#pragma mark - Text Input (via Hammer)

- (void)typeChar:(NSString *)character
         resolve:(RCTPromiseResolveBlock)resolve
          reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    UIWindow *window = [NativeHarness activeWindow];
    if (!window) { reject(@"NO_WINDOW", @"No active window", nil); return; }
    [HammerBridge typeText:character in:window completion:^(NSError *error) {
      if (error) {
        reject(@"TYPE_FAILED", error.localizedDescription, error);
      } else {
        resolve(nil);
      }
    }];
  });
}

- (UIResponder *)findFirstResponderIn:(UIView *)view {
  if ([view isFirstResponder]) return view;
  for (UIView *sub in view.subviews) {
    UIResponder *r = [self findFirstResponderIn:sub];
    if (r) return r;
  }
  return nil;
}

- (void)typeIntoView:(NSString *)nativeId
                text:(NSString *)text
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    // Focus the target view
    UIView *view = [NativeHarness viewForId:nativeId];
    if (view) {
      // For UITextField, tap to focus first
      UIWindow *window = view.window ?: [NativeHarness activeWindow];
      if (window) {
        CGRect frameInWindow = [view convertRect:view.bounds toView:window];
        CGPoint center = CGPointMake(CGRectGetMidX(frameInWindow), CGRectGetMidY(frameInWindow));
        [HammerBridge tapAt:center in:window completion:^(NSError *tapError) {
          // After tap focuses the field, insert text directly via UITextInput
          dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.1 * NSEC_PER_SEC)),
                         dispatch_get_main_queue(), ^{
            UIWindow *w = [NativeHarness activeWindow];
            UIResponder *responder = [self findFirstResponderIn:w];
            if ([responder conformsToProtocol:@protocol(UITextInput)]) {
              [(id<UITextInput>)responder insertText:text];
            }
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.05 * NSEC_PER_SEC)),
                           dispatch_get_main_queue(), ^{ resolve(nil); });
          });
        }];
      } else {
        reject(@"NO_WINDOW", @"No window for view", nil);
      }
    } else {
      reject(@"NO_VIEW", @"View not found", nil);
    }
  });
}

#pragma mark - Flush UI Queue

- (void)flushUIQueue:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    resolve(nil);
  });
}

#pragma mark - TurboModule

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params {
  return std::make_shared<facebook::react::NativeNativeHarnessSpecJSI>(params);
}

+ (NSString *)moduleName {
  return @"NativeHarness";
}

@end
