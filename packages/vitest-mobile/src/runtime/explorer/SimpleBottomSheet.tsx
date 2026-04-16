/**
 * Lightweight bottom sheet using plain RN Animated + PanResponder.
 * Replaces @gorhom/bottom-sheet to avoid native dependency on
 * react-native-reanimated and react-native-gesture-handler.
 */
import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  PanResponder,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '@shopify/restyle';
import type { Theme } from './theme';

export interface SimpleBottomSheetRef {
  snapToIndex: (index: number) => void;
  snapToPosition: (position: number) => void;
  animatedHeight: Animated.Value;
}

interface SimpleBottomSheetProps {
  snapPoints: (number | string)[];
  enableDynamicSizing?: boolean;
  maxDynamicContentSize?: number;
  index?: number;
  backgroundStyle?: ViewStyle;
  handleIndicatorStyle?: ViewStyle;
  children: React.ReactNode;
}

const SCREEN_HEIGHT = Dimensions.get('window').height;
const HANDLE_HEIGHT = 24;
const BOTTOM_INSET = 34;

function resolveSnapPoint(point: number | string): number {
  if (typeof point === 'number') return point;
  const pct = parseFloat(point) / 100;
  return SCREEN_HEIGHT * pct;
}

export const SimpleBottomSheet = React.forwardRef<SimpleBottomSheetRef, SimpleBottomSheetProps>(
  function SimpleBottomSheet(
    {
      snapPoints,
      enableDynamicSizing = true,
      maxDynamicContentSize = 140,
      index = -1,
      backgroundStyle,
      handleIndicatorStyle,
      children,
    },
    ref,
  ) {
    const { colors } = useTheme<Theme>();
    const styles = useMemo(() => createStyles(colors), [colors]);
    const resolvedSnaps = useMemo(() => snapPoints.map(resolveSnapPoint).sort((a, b) => a - b), [snapPoints]);

    const [peekHeight, setPeekHeight] = useState(80);
    const allSnaps = useMemo(() => {
      if (!enableDynamicSizing) return resolvedSnaps;
      const dynamic = Math.min(peekHeight + HANDLE_HEIGHT + BOTTOM_INSET, maxDynamicContentSize + BOTTOM_INSET);
      return [dynamic, ...resolvedSnaps].sort((a, b) => a - b);
    }, [resolvedSnaps, enableDynamicSizing, peekHeight, maxDynamicContentSize]);

    const currentSnapIdx = useRef(0);
    const sheetHeight = useRef(new Animated.Value(allSnaps[0] ?? 80)).current;
    const currentHeight = useRef(allSnaps[0] ?? 80);
    const dragStart = useRef(0);

    useEffect(() => {
      const id = sheetHeight.addListener(({ value }) => {
        currentHeight.current = value;
      });
      return () => sheetHeight.removeListener(id);
    }, [sheetHeight]);

    const snapTo = useCallback(
      (targetHeight: number) => {
        Animated.spring(sheetHeight, {
          toValue: targetHeight,
          useNativeDriver: false,
          tension: 80,
          friction: 12,
        }).start();
      },
      [sheetHeight],
    );

    const snapToIndex = useCallback(
      (idx: number) => {
        const clamped = Math.max(0, Math.min(idx, allSnaps.length - 1));
        currentSnapIdx.current = clamped;
        snapTo(allSnaps[clamped]);
      },
      [allSnaps, snapTo],
    );

    useImperativeHandle(
      ref,
      () => ({
        snapToIndex,
        snapToPosition: (pos: number) => snapTo(pos),
        animatedHeight: sheetHeight,
      }),
      [snapToIndex, snapTo, sheetHeight],
    );

    useEffect(() => {
      const idx = index === -1 ? 0 : Math.min(index, allSnaps.length - 1);
      currentSnapIdx.current = idx;
      sheetHeight.setValue(allSnaps[idx]);
    }, [allSnaps.length]); // eslint-disable-line react-hooks/exhaustive-deps

    const panResponder = useMemo(
      () =>
        PanResponder.create({
          onStartShouldSetPanResponder: () => false,
          onStartShouldSetPanResponderCapture: () => false,
          onMoveShouldSetPanResponder: (_, gestureState) => {
            return Math.abs(gestureState.dy) > 3;
          },
          onMoveShouldSetPanResponderCapture: (_, gestureState) => {
            return Math.abs(gestureState.dy) > 3;
          },
          onPanResponderTerminationRequest: () => false,
          onPanResponderGrant: () => {
            sheetHeight.stopAnimation();
            dragStart.current = currentHeight.current;
          },
          onPanResponderMove: (_, gestureState) => {
            const newHeight = Math.max(allSnaps[0], Math.min(dragStart.current - gestureState.dy, SCREEN_HEIGHT * 0.7));
            sheetHeight.setValue(newHeight);
          },
          onPanResponderRelease: (_, gestureState) => {
            const currentHeight = dragStart.current - gestureState.dy;
            const velocity = -gestureState.vy;

            let bestIdx = 0;
            let bestDist = Infinity;
            for (let i = 0; i < allSnaps.length; i++) {
              const dist = Math.abs(currentHeight - allSnaps[i]) - velocity * allSnaps[i] * 0.3;
              if (dist < bestDist) {
                bestDist = dist;
                bestIdx = i;
              }
            }

            currentSnapIdx.current = bestIdx;
            snapTo(allSnaps[bestIdx]);
          },
        }),
      [allSnaps, sheetHeight, snapTo],
    );

    const onPeekLayout = useCallback(
      (e: LayoutChangeEvent) => {
        const h = e.nativeEvent.layout.height;
        if (Math.abs(h - peekHeight) > 2) {
          setPeekHeight(h);
        }
      },
      [peekHeight],
    );

    const childArray = React.Children.toArray(children);
    const peekChild = childArray[0];
    const restChildren = childArray.slice(1);

    return (
      <Animated.View style={[styles.sheet, backgroundStyle, { height: sheetHeight }]}>
        <View {...panResponder.panHandlers}>
          <View style={styles.handleContainer}>
            <View style={[styles.handleIndicator, handleIndicatorStyle]} />
          </View>
          <View onLayout={onPeekLayout}>{peekChild}</View>
        </View>

        <View style={styles.contentContainer}>{restChildren}</View>

        <View style={{ height: 34 }} />
      </Animated.View>
    );
  },
);

const createStyles = (colors: Theme['colors']) =>
  StyleSheet.create({
    sheet: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      backgroundColor: colors.surface,
      borderTopLeftRadius: 12,
      borderTopRightRadius: 12,
      overflow: 'hidden',
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: 'rgba(148,163,184,0.3)',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: -6 },
      shadowOpacity: 0.6,
      shadowRadius: 20,
      elevation: 24,
    },
    handleContainer: {
      alignItems: 'center',
      paddingVertical: 8,
    },
    handleIndicator: {
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.textDim,
    },
    contentContainer: {
      flex: 1,
      overflow: 'hidden',
    },
  });
