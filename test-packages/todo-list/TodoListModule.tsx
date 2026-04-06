import React, { useState, useCallback } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';

export interface TodoListModuleProps {
  initialItems?: string[];
}

export function TodoListModule({ initialItems }: TodoListModuleProps) {
  const [items, setItems] = useState<string[]>(initialItems ?? []);
  const [inputText, setInputText] = useState('');

  const handleAdd = useCallback(() => {
    if (!inputText) {
      return;
    }
    setItems(prev => [...prev, inputText]);
    setInputText('');
  }, [inputText]);

  const handleDelete = useCallback((index: number) => {
    setItems(prev => prev.filter((_, i) => i !== index));
  }, []);

  return (
    <View style={styles.container}>
      <TextInput
        testID="todo-input"
        style={styles.input}
        value={inputText}
        onChangeText={setInputText}
        placeholder="New item"
        placeholderTextColor="#64748b"
      />
      <TouchableOpacity testID="add-btn" style={styles.button} onPress={handleAdd}>
        <Text style={styles.buttonText}>Add</Text>
      </TouchableOpacity>
      <Text testID="item-count" style={styles.count}>
        {items.length} items
      </Text>
      {items.length === 0 ? (
        <Text testID="empty-message" style={styles.empty}>
          No items yet
        </Text>
      ) : (
        items.map((item, index) => (
          <View key={`${index}-${item}`} testID={`todo-item-${index}`} style={styles.itemRow}>
            <Text testID={`todo-text-${index}`} style={styles.itemText}>
              {item}
            </Text>
            <TouchableOpacity testID={`delete-btn-${index}`} style={styles.deleteBtn} onPress={() => handleDelete(index)}>
              <Text style={styles.deleteBtnText}>Delete</Text>
            </TouchableOpacity>
          </View>
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 20,
    alignItems: 'stretch',
    gap: 12,
  },
  input: {
    width: '100%',
    maxWidth: 280,
    alignSelf: 'center',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: '#e2e8f0',
    backgroundColor: '#1e293b',
  },
  button: {
    alignSelf: 'center',
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
    textAlign: 'center',
  },
  empty: {
    fontSize: 14,
    color: '#64748b',
    textAlign: 'center',
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#1e293b',
    maxWidth: 320,
    alignSelf: 'center',
    width: '100%',
  },
  itemText: {
    flex: 1,
    fontSize: 16,
    color: '#e2e8f0',
  },
  deleteBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: '#475569',
  },
  deleteBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});
