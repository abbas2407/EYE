import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { apiFetch, getUserName } from '../api/client';

interface ScheduleScreenProps {
  isPunchedIn: boolean;
  punchInTime: string | null;
  isPunchSyncing: boolean;
  onPunchPress: () => void;
  onNavigateToMap: () => void;
  onNavigateToDailySummary: () => void;
}

interface Task {
  id: string;
  title: string;
  location?: string;
  scheduled_time?: string;
  status: string;
  description?: string;
}

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  completed: { bg: '#dcfce7', text: '#166534', label: 'COMPLETED' },
  in_route: { bg: '#fef3c7', text: '#92400e', label: 'IN ROUTE' },
  upcoming: { bg: '#efeeeb', text: '#747878', label: 'UPCOMING' },
  pending: { bg: '#efeeeb', text: '#747878', label: 'PENDING' },
  flagged: { bg: '#fee2e2', text: '#991b1b', label: 'FLAGGED' },
};

function getStatusStyle(status: string) {
  return STATUS_STYLES[status.toLowerCase()] ?? STATUS_STYLES.pending;
}

function getDaysOfWeek() {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const today = new Date();
  const result = [];
  const startOfWeek = new Date(today);
  startOfWeek.setDate(today.getDate() - today.getDay() + 1); // Monday

  for (let i = 0; i < 7; i++) {
    const d = new Date(startOfWeek);
    d.setDate(startOfWeek.getDate() + i);
    result.push({
      dayName: days[d.getDay()],
      dayNum: d.getDate(),
      isToday: d.toDateString() === today.toDateString(),
      date: d,
    });
  }
  return result;
}

function formatTime(isoString?: string): string {
  if (!isoString) return '--:--';
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  } catch {
    return '--:--';
  }
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
}

export default function ScheduleScreen({
  isPunchedIn,
  punchInTime,
  isPunchSyncing,
  onPunchPress,
  onNavigateToMap,
  onNavigateToDailySummary,
}: ScheduleScreenProps) {
  const [userName, setUserName] = useState('');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedDayIndex, setSelectedDayIndex] = useState(0);
  const [days] = useState(getDaysOfWeek);

  const todayIndex = days.findIndex(d => d.isToday);

  useEffect(() => {
    getUserName().then(n => setUserName(n ?? 'Team Member'));
    setSelectedDayIndex(todayIndex >= 0 ? todayIndex : 0);
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

  const greeting = () => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  };

  const activeTask = tasks.find(t => t.status.toLowerCase() === 'in_route' || t.status.toLowerCase() === 'upcoming');

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#faf9f6' }} edges={['top']}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#695d4a" />}
      >
        {/* Header */}
        <View style={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 }}>
          <Text style={{ fontSize: 11, color: '#695d4a', textTransform: 'uppercase', letterSpacing: 1.5, fontFamily: 'DM-Sans' }}>
            {greeting()}
          </Text>
          <Text style={{ fontSize: 26, fontFamily: 'PlayfairDisplay-Bold', color: '#1a1c1a', marginTop: 2 }}>
            {userName}
          </Text>
          <Text style={{ fontSize: 12, color: '#747878', fontFamily: 'DM-Sans', marginTop: 2 }}>
            {formatDate(new Date())}
          </Text>
        </View>

        {/* Punch Status Banner */}
        <View style={{ marginHorizontal: 20, marginVertical: 12 }}>
          {isPunchSyncing ? (
            <View style={{
              backgroundColor: '#f5f4f1', borderRadius: 8, padding: 16,
              flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
            }}>
              <ActivityIndicator size="small" color="#695d4a" />
              <Text style={{ fontSize: 12, color: '#695d4a', fontFamily: 'DM-Sans', textTransform: 'uppercase', letterSpacing: 1 }}>
                Checking status…
              </Text>
            </View>
          ) : isPunchedIn ? (
            <View style={{
              backgroundColor: '#dcfce7',
              borderRadius: 8,
              padding: 14,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }}>
                <Ionicons name="checkmark-circle" size={20} color="#166534" />
                <View>
                  <Text style={{ fontSize: 11, color: '#166534', fontFamily: 'DM-Sans', fontWeight: '600' }}>
                    Attendance Marked
                  </Text>
                  {punchInTime && (
                    <Text style={{ fontSize: 10, color: '#166534', fontFamily: 'DM-Sans', marginTop: 1 }}>
                      Punched in at {punchInTime}
                    </Text>
                  )}
                </View>
              </View>
              <TouchableOpacity
                onPress={onPunchPress}
                style={{
                  backgroundColor: '#1a1c1a',
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  borderRadius: 4,
                }}
              >
                <Text style={{ color: '#fff', fontSize: 10, fontFamily: 'DM-Sans', fontWeight: '500', textTransform: 'uppercase', letterSpacing: 1 }}>
                  Punch Out
                </Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity
              onPress={onPunchPress}
              style={{
                backgroundColor: '#1a1c1a',
                borderRadius: 8,
                padding: 16,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
              }}
            >
              <Ionicons name="finger-print-outline" size={20} color="#fff" />
              <Text style={{
                color: '#fff',
                fontSize: 12,
                fontFamily: 'DM-Sans',
                fontWeight: '500',
                textTransform: 'uppercase',
                letterSpacing: 1.5,
              }}>
                Punch In
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Date strip */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 8, gap: 8 }}
        >
          {days.map((day, idx) => {
            const isSelected = selectedDayIndex === idx;
            return (
              <TouchableOpacity
                key={idx}
                onPress={() => setSelectedDayIndex(idx)}
                style={{
                  alignItems: 'center',
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                  borderRadius: 8,
                  backgroundColor: isSelected ? '#1a1c1a' : '#fff',
                  borderWidth: 0.5,
                  borderColor: isSelected ? '#1a1c1a' : '#e3e2e0',
                  minWidth: 52,
                }}
              >
                <Text style={{
                  fontSize: 9,
                  textTransform: 'uppercase',
                  letterSpacing: 0.8,
                  color: isSelected ? '#fff' : '#747878',
                  fontFamily: 'DM-Sans',
                }}>
                  {day.dayName}
                </Text>
                <Text style={{
                  fontSize: 16,
                  fontWeight: '700',
                  color: isSelected ? '#fff' : '#1a1c1a',
                  marginTop: 2,
                  fontFamily: 'DM-Sans',
                }}>
                  {day.dayNum}
                </Text>
                {day.isToday && !isSelected && (
                  <View style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: '#695d4a', marginTop: 3 }} />
                )}
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {/* Active task CTA */}
        {activeTask && (
          <View style={{ marginHorizontal: 20, marginBottom: 8 }}>
            <TouchableOpacity
              onPress={onNavigateToMap}
              style={{
                backgroundColor: '#f2e0c8',
                borderRadius: 8,
                padding: 14,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <Ionicons name="navigate-circle-outline" size={22} color="#695d4a" />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 10, color: '#695d4a', textTransform: 'uppercase', letterSpacing: 1, fontFamily: 'DM-Sans' }}>
                  Active Task
                </Text>
                <Text style={{ fontSize: 13, fontWeight: '600', color: '#1a1c1a', fontFamily: 'DM-Sans', marginTop: 1 }}>
                  {activeTask.title}
                </Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Text style={{ fontSize: 10, color: '#695d4a', fontFamily: 'DM-Sans', fontWeight: '500', textTransform: 'uppercase', letterSpacing: 0.8 }}>
                  Navigate
                </Text>
                <Ionicons name="chevron-forward" size={14} color="#695d4a" />
              </View>
            </TouchableOpacity>
          </View>
        )}

        {/* Daily summary shortcut */}
        <TouchableOpacity
          onPress={onNavigateToDailySummary}
          style={{ marginHorizontal: 20, marginBottom: 8, backgroundColor: '#fff', borderRadius: 8, padding: 12, borderWidth: 0.5, borderColor: '#e3e2e0', flexDirection: 'row', alignItems: 'center', gap: 10 }}
        >
          <Ionicons name="bar-chart-outline" size={18} color="#695d4a" />
          <Text style={{ flex: 1, fontSize: 12, color: '#1a1c1a', fontFamily: 'DM-Sans' }}>View Daily Summary</Text>
          <Ionicons name="chevron-forward" size={14} color="#c4c7c7" />
        </TouchableOpacity>

        {/* Tasks section header */}
        <View style={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ fontSize: 9, color: '#695d4a', textTransform: 'uppercase', letterSpacing: 1.5, fontFamily: 'DM-Sans' }}>
            Today's Tasks
          </Text>
          <Text style={{ fontSize: 10, color: '#747878', fontFamily: 'DM-Sans' }}>
            {tasks.length} assigned
          </Text>
        </View>

        {/* Task list */}
        {loading ? (
          <View style={{ paddingVertical: 40, alignItems: 'center' }}>
            <ActivityIndicator size="large" color="#695d4a" />
            <Text style={{ marginTop: 12, fontSize: 12, color: '#747878', fontFamily: 'DM-Sans' }}>
              Loading tasks...
            </Text>
          </View>
        ) : tasks.length === 0 ? (
          <View style={{ paddingVertical: 48, alignItems: 'center', paddingHorizontal: 32 }}>
            <Ionicons name="calendar-outline" size={40} color="#c4c7c7" />
            <Text style={{ fontSize: 15, fontWeight: '600', color: '#1a1c1a', marginTop: 12, fontFamily: 'DM-Sans' }}>
              No tasks assigned today
            </Text>
            <Text style={{ fontSize: 12, color: '#747878', marginTop: 6, textAlign: 'center', fontFamily: 'DM-Sans', lineHeight: 18 }}>
              Pull down to refresh or check back later.
            </Text>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 20, paddingBottom: 24, gap: 8 }}>
            {tasks.map((task, idx) => {
              const style = getStatusStyle(task.status);
              return (
                <View
                  key={task.id ?? idx}
                  style={{
                    backgroundColor: '#fff',
                    borderRadius: 8,
                    padding: 14,
                    borderWidth: 0.5,
                    borderColor: '#e3e2e0',
                  }}
                >
                  {/* Timeline dot + line */}
                  <View style={{ flexDirection: 'row', gap: 12 }}>
                    <View style={{ alignItems: 'center' }}>
                      <View style={{
                        width: 8, height: 8, borderRadius: 4,
                        backgroundColor: task.status.toLowerCase() === 'completed' ? '#166534' : '#695d4a',
                        marginTop: 4,
                      }} />
                      {idx < tasks.length - 1 && (
                        <View style={{ width: 1, flex: 1, backgroundColor: '#e3e2e0', marginTop: 4 }} />
                      )}
                    </View>
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 6 }}>
                        <Text style={{ fontSize: 14, fontWeight: '600', color: '#1a1c1a', fontFamily: 'DM-Sans', flex: 1 }}>
                          {task.title}
                        </Text>
                        <View style={{ backgroundColor: style.bg, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4, marginLeft: 8 }}>
                          <Text style={{ fontSize: 8, color: style.text, fontFamily: 'DM-Sans', fontWeight: '600', letterSpacing: 0.5 }}>
                            {style.label}
                          </Text>
                        </View>
                      </View>
                      {task.location && (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 4 }}>
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
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
