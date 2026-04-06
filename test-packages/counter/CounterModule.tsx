/**
 * CounterModule — example component for demonstrating the test harness.
 *
 * Features:
 * - Local count state with increment button
 * - Fetch data from API with loading/error states
 * - Accepts props: userId, variant, onCountChange
 */

import React, { useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';

export interface CounterModuleProps {
  userId: string;
  variant?: 'default' | 'compact';
  onCountChange?: (count: number) => void;
}

export function CounterModule({ userId, variant = 'default', onCountChange }: CounterModuleProps) {
  const [count, setCount] = useState(0);
  const [apiResult, setApiResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleIncrement = useCallback(() => {
    const next = count + 1;
    setCount(next);
    onCountChange?.(next);
  }, [count, onCountChange]);

  const handleLoad = useCallback(async () => {
    setLoading(true);
    setError(null);
    setApiResult(null);

    try {
      const response = await fetch(`/api/data?userId=${userId}`);
      if (!response.ok) throw new Error('Request failed');
      const data = await response.json();
      setApiResult(String(data.value));
    } catch (err: any) {
      setError(err?.message ?? 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  if (variant === 'compact') {
    return (
      <View testID="compact-layout" style={styles.compact}>
        <Text testID="count-display">{count}</Text>
        <TouchableOpacity testID="increment-btn" onPress={handleIncrement}>
          <Text>+</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View testID="counter-root" style={styles.container}>
      <Text testID="count-display" style={styles.count}>
        {count}
      </Text>

      <TouchableOpacity testID="increment-btn" style={styles.button} onPress={handleIncrement}>
        <Text style={styles.buttonText}>Increment</Text>
      </TouchableOpacity>

      <TouchableOpacity testID="load-btn" style={[styles.button, styles.loadButton]} onPress={handleLoad}>
        <Text style={styles.buttonText}>Load Data</Text>
      </TouchableOpacity>

      {loading && <ActivityIndicator testID="loading-spinner" size="small" color="#6366f1" />}

      {apiResult !== null && (
        <Text testID="api-result" style={styles.result}>
          {apiResult}
        </Text>
      )}

      {error !== null && (
        <Text testID="error-message" style={styles.error}>
          {error}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 20,
    alignItems: 'center',
    gap: 12,
  },
  compact: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 8,
  },
  count: {
    fontSize: 48,
    fontWeight: '700',
    color: '#e2e8f0',
  },
  button: {
    backgroundColor: '#6366f1',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  loadButton: {
    backgroundColor: '#8b5cf6',
  },
  buttonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 16,
  },
  result: {
    fontSize: 24,
    fontWeight: '600',
    color: '#4ade80',
  },
  error: {
    fontSize: 14,
    color: '#f87171',
  },
});
