import React, { useState, useCallback } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';

export interface GreetingModuleProps {
  defaultName?: string;
}

export function GreetingModule({ defaultName }: GreetingModuleProps) {
  const [name, setName] = useState(defaultName ?? '');

  const clearName = useCallback(() => {
    setName('');
  }, []);

  return (
    <View style={styles.container}>
      <TextInput
        testID="name-input"
        style={styles.input}
        value={name}
        onChangeText={setName}
        placeholder="Name"
        placeholderTextColor="#64748b"
      />
      <Text testID="greeting-text" style={styles.greeting}>
        {name.length > 0 ? `Hello, ${name}!` : 'Enter your name'}
      </Text>
      <TouchableOpacity testID="clear-btn" style={styles.button} onPress={clearName}>
        <Text style={styles.buttonText}>Clear</Text>
      </TouchableOpacity>
      <Text testID="char-count" style={styles.count}>
        {name.length} characters
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 20,
    alignItems: 'center',
    gap: 12,
  },
  input: {
    width: '100%',
    maxWidth: 280,
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: '#e2e8f0',
    backgroundColor: '#1e293b',
  },
  greeting: {
    fontSize: 18,
    fontWeight: '600',
    color: '#e2e8f0',
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
  count: {
    fontSize: 14,
    color: '#94a3b8',
  },
});
