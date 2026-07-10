import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  ActivityIndicator, TextInput, RefreshControl, Alert
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { apiFetch } from '../api/client';

interface FormField {
  id: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'checkbox' | 'textarea';
  required?: boolean;
  options?: string[];
}

interface Task {
  id: string;
  title: string;
  location?: string;
  scheduled_time?: string;
  status: string;
  description?: string;
  form_fields?: FormField[];
  client_name?: string;
}

type FilterChip = 'ALL' | 'PENDING' | 'IN_ROUTE' | 'COMPLETED';

const STATUS_MAP: Record<string, { bg: string; text: string; label: string }> = {
  completed: { bg: '#dcfce7', text: '#166534', label: 'COMPLETED' },
  in_route: { bg: '#fef3c7', text: '#92400e', label: 'IN ROUTE' },
  upcoming: { bg: '#efeeeb', text: '#747878', label: 'UPCOMING' },
  pending: { bg: '#efeeeb', text: '#747878', label: 'PENDING' },
  flagged: { bg: '#fee2e2', text: '#991b1b', label: 'FLAGGED' },
};

function getStatusStyle(status: string) {
  return STATUS_MAP[status.toLowerCase()] ?? STATUS_MAP.pending;
}

function formatTime(isoString?: string): string {
  if (!isoString) return '--:--';
  try {
    return new Date(isoString).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  } catch {
    return '--:--';
  }
}

export default function TasksScreen() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeFilter, setActiveFilter] = useState<FilterChip>('ALL');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [formValues, setFormValues] = useState<Record<string, Record<string, string>>>({});
  const [submitting, setSubmitting] = useState<string | null>(null);

  useEffect(() => {
    fetchTasks();
  }, []);

  const fetchTasks = useCallback(async () => {
    try {
      const res = await apiFetch('/api/tasks/my-tasks');
      if (res.ok) {
        const data = await res.json();
        setTasks(Array.isArray(data) ? data : data.tasks ?? []);
      }
    } catch {}
    finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const onRefresh = () => {
    setRefreshing(true);
    fetchTasks();
  };

  const filteredTasks = tasks.filter(t => {
    if (activeFilter === 'ALL') return true;
    if (activeFilter === 'PENDING') return ['pending', 'upcoming'].includes(t.status.toLowerCase());
    if (activeFilter === 'IN_ROUTE') return t.status.toLowerCase() === 'in_route';
    if (activeFilter === 'COMPLETED') return t.status.toLowerCase() === 'completed';
    return true;
  });

  function setFieldValue(taskId: string, fieldId: string, value: string) {
    setFormValues(prev => ({
      ...prev,
      [taskId]: { ...(prev[taskId] ?? {}), [fieldId]: value },
    }));
  }

  async function submitForm(task: Task) {
    setSubmitting(task.id);
    try {
      const values = formValues[task.id] ?? {};
      const res = await apiFetch(`/api/tasks/${task.id}/submit-form`, {
        method: 'POST',
        body: JSON.stringify({ form_data: values }),
      });
      if (res.ok) {
        Alert.alert('Success', 'Task form submitted successfully.');
        setExpandedId(null);
        fetchTasks();
      } else {
        const err = await res.json().catch(() => ({}));
        Alert.alert('Error', err.detail ?? 'Failed to submit form.');
      }
    } catch {
      Alert.alert('Error', 'Network error. Please try again.');
    } finally {
      setSubmitting(null);
    }
  }

  const filters: { key: FilterChip; label: string }[] = [
    { key: 'ALL', label: 'All' },
    { key: 'PENDING', label: 'Pending' },
    { key: 'IN_ROUTE', label: 'In Route' },
    { key: 'COMPLETED', label: 'Completed' },
  ];

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#faf9f6' }} edges={['top']}>
      {/* Header */}
      <View style={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 }}>
        <Text style={{ fontSize: 9, color: '#695d4a', textTransform: 'uppercase', letterSpacing: 1.5, fontFamily: 'DM-Sans' }}>
          My Work
        </Text>
        <Text style={{ fontSize: 26, fontFamily: 'PlayfairDisplay-Bold', color: '#1a1c1a', marginTop: 2 }}>
          Tasks
        </Text>
      </View>

      {/* Filter chips */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 10, gap: 8 }}
      >
        {filters.map(f => {
          const isActive = activeFilter === f.key;
          const count = f.key === 'ALL'
            ? tasks.length
            : tasks.filter(t => {
                if (f.key === 'PENDING') return ['pending', 'upcoming'].includes(t.status.toLowerCase());
                if (f.key === 'IN_ROUTE') return t.status.toLowerCase() === 'in_route';
                if (f.key === 'COMPLETED') return t.status.toLowerCase() === 'completed';
                return false;
              }).length;
          return (
            <TouchableOpacity
              key={f.key}
              onPress={() => setActiveFilter(f.key)}
              style={{
                flexDirection: 'row', alignItems: 'center', gap: 6,
                paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20,
                backgroundColor: isActive ? '#1a1c1a' : '#fff',
                borderWidth: 0.5, borderColor: isActive ? '#1a1c1a' : '#e3e2e0',
              }}
            >
              <Text style={{
                fontSize: 11, fontFamily: 'DM-Sans',
                color: isActive ? '#fff' : '#1a1c1a',
                fontWeight: isActive ? '600' : '400',
              }}>
                {f.label}
              </Text>
              <View style={{
                minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4,
                backgroundColor: isActive ? 'rgba(255,255,255,0.2)' : '#efeeeb',
                justifyContent: 'center', alignItems: 'center',
              }}>
                <Text style={{ fontSize: 9, color: isActive ? '#fff' : '#747878', fontFamily: 'DM-Sans' }}>
                  {count}
                </Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Task list */}
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#695d4a" />}
      >
        {loading ? (
          <View style={{ paddingVertical: 60, alignItems: 'center' }}>
            <ActivityIndicator size="large" color="#695d4a" />
            <Text style={{ marginTop: 12, fontSize: 12, color: '#747878', fontFamily: 'DM-Sans' }}>
              Loading tasks...
            </Text>
          </View>
        ) : filteredTasks.length === 0 ? (
          <View style={{ paddingVertical: 60, alignItems: 'center' }}>
            <Ionicons name="clipboard-outline" size={40} color="#c4c7c7" />
            <Text style={{ fontSize: 15, fontWeight: '600', color: '#1a1c1a', marginTop: 12, fontFamily: 'DM-Sans' }}>
              No tasks found
            </Text>
            <Text style={{ fontSize: 12, color: '#747878', marginTop: 6, textAlign: 'center', fontFamily: 'DM-Sans' }}>
              {activeFilter !== 'ALL' ? 'Try a different filter.' : 'No tasks assigned to you.'}
            </Text>
          </View>
        ) : (
          <View style={{ gap: 8, paddingTop: 4 }}>
            {filteredTasks.map(task => {
              const style = getStatusStyle(task.status);
              const isExpanded = expandedId === task.id;

              return (
                <View
                  key={task.id}
                  style={{
                    backgroundColor: '#fff',
                    borderRadius: 8,
                    borderWidth: 0.5,
                    borderColor: '#e3e2e0',
                    overflow: 'hidden',
                  }}
                >
                  <TouchableOpacity
                    onPress={() => setExpandedId(isExpanded ? null : task.id)}
                    style={{ padding: 14 }}
                    activeOpacity={0.7}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 14, fontWeight: '600', color: '#1a1c1a', fontFamily: 'DM-Sans' }}>
                          {task.title}
                        </Text>
                        {task.client_name && (
                          <Text style={{ fontSize: 11, color: '#695d4a', fontFamily: 'DM-Sans', marginTop: 2 }}>
                            {task.client_name}
                          </Text>
                        )}
                      </View>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 8 }}>
                        <View style={{ backgroundColor: style.bg, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4 }}>
                          <Text style={{ fontSize: 8, color: style.text, fontFamily: 'DM-Sans', fontWeight: '600', letterSpacing: 0.5 }}>
                            {style.label}
                          </Text>
                        </View>
                        <Ionicons
                          name={isExpanded ? 'chevron-up' : 'chevron-down'}
                          size={14}
                          color="#747878"
                        />
                      </View>
                    </View>

                    <View style={{ flexDirection: 'row', gap: 16, marginTop: 8 }}>
                      {task.location && (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                          <Ionicons name="location-outline" size={11} color="#747878" />
                          <Text style={{ fontSize: 11, color: '#747878', fontFamily: 'DM-Sans' }} numberOfLines={1}>
                            {task.location}
                          </Text>
                        </View>
                      )}
                      {task.scheduled_time && (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                          <Ionicons name="time-outline" size={11} color="#747878" />
                          <Text style={{ fontSize: 11, color: '#747878', fontFamily: 'DM-Sans' }}>
                            {formatTime(task.scheduled_time)}
                          </Text>
                        </View>
                      )}
                    </View>
                  </TouchableOpacity>

                  {/* Expanded details */}
                  {isExpanded && (
                    <View style={{ borderTopWidth: 0.5, borderTopColor: '#efeeeb', padding: 14 }}>
                      {task.description && (
                        <Text style={{ fontSize: 12, color: '#444748', fontFamily: 'DM-Sans', lineHeight: 18, marginBottom: 14 }}>
                          {task.description}
                        </Text>
                      )}

                      {/* Dynamic form fields */}
                      {task.form_fields && task.form_fields.length > 0 && (
                        <View style={{ gap: 14 }}>
                          <Text style={{ fontSize: 9, color: '#695d4a', textTransform: 'uppercase', letterSpacing: 1.5, fontFamily: 'DM-Sans', fontWeight: '500' }}>
                            Task Form
                          </Text>
                          {task.form_fields.map(field => (
                            <View key={field.id}>
                              <Text style={{ fontSize: 10, color: '#695d4a', textTransform: 'uppercase', letterSpacing: 1, fontFamily: 'DM-Sans', marginBottom: 6 }}>
                                {field.label}{field.required && ' *'}
                              </Text>
                              {(field.type === 'text' || field.type === 'number') && (
                                <TextInput
                                  style={{
                                    borderWidth: 0.5,
                                    borderColor: '#c4c7c7',
                                    borderRadius: 4,
                                    paddingHorizontal: 12,
                                    paddingVertical: 10,
                                    fontSize: 13,
                                    color: '#1a1c1a',
                                    fontFamily: 'DM-Sans',
                                    backgroundColor: '#faf9f6',
                                  }}
                                  placeholder={`Enter ${field.label.toLowerCase()}`}
                                  placeholderTextColor="#c4c7c7"
                                  keyboardType={field.type === 'number' ? 'numeric' : 'default'}
                                  value={formValues[task.id]?.[field.id] ?? ''}
                                  onChangeText={v => setFieldValue(task.id, field.id, v)}
                                />
                              )}
                              {field.type === 'textarea' && (
                                <TextInput
                                  style={{
                                    borderWidth: 0.5,
                                    borderColor: '#c4c7c7',
                                    borderRadius: 4,
                                    paddingHorizontal: 12,
                                    paddingVertical: 10,
                                    fontSize: 13,
                                    color: '#1a1c1a',
                                    fontFamily: 'DM-Sans',
                                    backgroundColor: '#faf9f6',
                                    minHeight: 80,
                                    textAlignVertical: 'top',
                                  }}
                                  placeholder={`Enter ${field.label.toLowerCase()}`}
                                  placeholderTextColor="#c4c7c7"
                                  multiline
                                  numberOfLines={4}
                                  value={formValues[task.id]?.[field.id] ?? ''}
                                  onChangeText={v => setFieldValue(task.id, field.id, v)}
                                />
                              )}
                              {field.type === 'select' && field.options && (
                                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                                  {field.options.map(opt => {
                                    const isSelected = formValues[task.id]?.[field.id] === opt;
                                    return (
                                      <TouchableOpacity
                                        key={opt}
                                        onPress={() => setFieldValue(task.id, field.id, opt)}
                                        style={{
                                          paddingHorizontal: 12, paddingVertical: 7, borderRadius: 4,
                                          backgroundColor: isSelected ? '#1a1c1a' : '#fff',
                                          borderWidth: 0.5, borderColor: isSelected ? '#1a1c1a' : '#c4c7c7',
                                        }}
                                      >
                                        <Text style={{ fontSize: 11, color: isSelected ? '#fff' : '#1a1c1a', fontFamily: 'DM-Sans' }}>
                                          {opt}
                                        </Text>
                                      </TouchableOpacity>
                                    );
                                  })}
                                </View>
                              )}
                              {field.type === 'checkbox' && (
                                <TouchableOpacity
                                  onPress={() => setFieldValue(task.id, field.id, formValues[task.id]?.[field.id] === 'true' ? 'false' : 'true')}
                                  style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
                                >
                                  <View style={{
                                    width: 20, height: 20, borderRadius: 4,
                                    borderWidth: 1, borderColor: '#c4c7c7',
                                    backgroundColor: formValues[task.id]?.[field.id] === 'true' ? '#1a1c1a' : '#fff',
                                    justifyContent: 'center', alignItems: 'center',
                                  }}>
                                    {formValues[task.id]?.[field.id] === 'true' && (
                                      <Ionicons name="checkmark" size={12} color="#fff" />
                                    )}
                                  </View>
                                  <Text style={{ fontSize: 12, color: '#1a1c1a', fontFamily: 'DM-Sans' }}>
                                    {field.label}
                                  </Text>
                                </TouchableOpacity>
                              )}
                            </View>
                          ))}

                          <TouchableOpacity
                            onPress={() => submitForm(task)}
                            disabled={submitting === task.id}
                            style={{
                              backgroundColor: '#1a1c1a', paddingVertical: 14, borderRadius: 4,
                              alignItems: 'center', justifyContent: 'center',
                              flexDirection: 'row', gap: 8, marginTop: 4,
                              opacity: submitting === task.id ? 0.6 : 1,
                            }}
                          >
                            {submitting === task.id ? (
                              <ActivityIndicator size="small" color="#fff" />
                            ) : (
                              <>
                                <Ionicons name="checkmark-circle-outline" size={16} color="#fff" />
                                <Text style={{ color: '#fff', fontFamily: 'DM-Sans', fontWeight: '500', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 }}>
                                  Submit Form
                                </Text>
                              </>
                            )}
                          </TouchableOpacity>
                        </View>
                      )}

                      {(!task.form_fields || task.form_fields.length === 0) && (
                        <View style={{ alignItems: 'center', paddingVertical: 12 }}>
                          <Text style={{ fontSize: 12, color: '#c4c7c7', fontFamily: 'DM-Sans' }}>
                            No form required for this task.
                          </Text>
                        </View>
                      )}
                    </View>
                  )}
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
