import React, { useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';

export interface ToggleModuleProps {
  label: string;
  onToggle?: (value: boolean) => void;
}

export function ToggleModule({ label, onToggle }: ToggleModuleProps) {
  const [isOn, setIsOn] = useState(false);

  const handlePress = useCallback(() => {
    setIsOn(prev => {
      const next = !prev;
      onToggle?.(next);
      return next;
    });
  }, [onToggle]);

  return (
    <View style={styles.container}>
      <Text style={styles.label}>{label}</Text>
      <Text testID="toggle-label" style={styles.state}>
        {isOn ? 'ON' : 'OFF'}
      </Text>
      <TouchableOpacity testID="toggle-btn" style={styles.button} onPress={handlePress}>
        <Text style={styles.buttonText}>Toggle</Text>
      </TouchableOpacity>
      {isOn && (
        <View testID="details-panel" style={styles.details}>
          <Text testID="details-text">Details visible</Text>
        </View>
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
  label: {
    fontSize: 16,
    fontWeight: '600',
    color: '#e2e8f0',
  },
  state: {
    fontSize: 24,
    fontWeight: '700',
    color: '#94a3b8',
  },
  button: {
    backgroundColor: '#6366f1',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  buttonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 16,
  },
  details: {
    marginTop: 8,
    padding: 12,
    borderRadius: 8,
    backgroundColor: '#1e293b',
  },
});
