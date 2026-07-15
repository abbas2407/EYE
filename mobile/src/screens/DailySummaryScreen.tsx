import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { apiFetch } from '../api/client';

interface DailySummaryScreenProps {
  onBack: () => void;
}

interface TaskItem {
  id: string;
  title: string;
  status: string;
  location?: string;
  scheduled_time?: string;
}

interface Summary {
  date: string;
  is_punched_in: boolean;
  punch_in_time?: string;
  total_hours_today: number;
  total_shifts: number;
  tasks_today: number;
  tasks_completed_today: number;
  km_today: number;
  tasks: TaskItem[];
}

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  completed: { bg: '#dcfce7', text: '#166534' },
  pending:   { bg: '#efeeeb', text: '#747878' },
  in_route:  { bg: '#fef3c7', text: '#92400e' },
  upcoming:  { bg: '#efeeeb', text: '#747878' },
};

function formatTime(iso?: string) {
  if (!iso) return '--:--';
  try {
    return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  } catch { return '--:--'; }
}

function formatDate(dateStr: string) {
  try {
    return new Date(dateStr).toLocaleDateString('en-IN', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });
  } catch { return dateStr; }
}

export default function DailySummaryScreen({ onBack }: DailySummaryScreenProps) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchSummary = useCallback(async () => {
    try {
      const res = await apiFetch('/api/daily-summary');
      if (res.ok) setSummary(await res.json());
    } catch {}
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { fetchSummary(); }, []);

  const stats = summary ? [
    { label: 'Hours Today', value: summary.total_hours_today ? `${summary.total_hours_today.toFixed(1)}h` : '0h', icon: 'time-outline' },
    { label: 'Tasks Done', value: `${summary.tasks_completed_today}/${summary.tasks_today}`, icon: 'checkmark-circle-outline' },
    { label: 'Shifts', value: summary.total_shifts.toString(), icon: 'calendar-outline' },
    { label: 'Distance', value: summary.km_today ? (summary.km_today >= 1 ? `${summary.km_today.toFixed(1)} km` : `${Math.round(summary.km_today * 1000)} m`) : '0 m', icon: 'navigate-outline' },
  ] : [];

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#faf9f6' }} edges={['top']}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchSummary(); }} tintColor="#695d4a" />}
      >
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12, gap: 12 }}>
          <TouchableOpacity onPress={onBack} style={{ padding: 4 }}>
            <Ionicons name="arrow-back" size={22} color="#1a1c1a" />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 9, color: '#695d4a', textTransform: 'uppercase', letterSpacing: 1.5, fontFamily: 'DM-Sans' }}>
              Today's Overview
            </Text>
            <Text style={{ fontSize: 22, fontFamily: 'PlayfairDisplay-Bold', color: '#1a1c1a', marginTop: 2 }}>
              Daily Summary
            </Text>
          </View>
        </View>

        {loading ? (
          <View style={{ paddingVertical: 60, alignItems: 'center' }}>
            <ActivityIndicator size="large" color="#695d4a" />
          </View>
        ) : !summary ? (
          <View style={{ paddingVertical: 60, alignItems: 'center' }}>
            <Ionicons name="cloud-offline-outline" size={40} color="#c4c7c7" />
            <Text style={{ fontSize: 13, color: '#747878', fontFamily: 'DM-Sans', marginTop: 12 }}>
              Unable to load summary
            </Text>
          </View>
        ) : (
          <>
            {/* Date + punch status */}
            <View style={{ marginHorizontal: 20, marginBottom: 16 }}>
              <Text style={{ fontSize: 12, color: '#747878', fontFamily: 'DM-Sans', marginBottom: 10 }}>
                {formatDate(summary.date)}
              </Text>
              <View style={{
                backgroundColor: summary.is_punched_in ? '#dcfce7' : '#fff',
                borderRadius: 10, padding: 14,
                borderWidth: 0.5, borderColor: summary.is_punched_in ? '#86efac' : '#e3e2e0',
                flexDirection: 'row', alignItems: 'center', gap: 12,
              }}>
                <Ionicons
                  name={summary.is_punched_in ? 'radio-button-on' : 'radio-button-off'}
                  size={22}
                  color={summary.is_punched_in ? '#166534' : '#c4c7c7'}
                />
                <View>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: '#1a1c1a', fontFamily: 'DM-Sans' }}>
                    {summary.is_punched_in ? 'Currently Clocked In' : 'Not Clocked In Today'}
                  </Text>
                  {summary.punch_in_time && (
                    <Text style={{ fontSize: 11, color: '#747878', fontFamily: 'DM-Sans', marginTop: 2 }}>
                      Punched in at {formatTime(summary.punch_in_time)}
                    </Text>
                  )}
                </View>
              </View>
            </View>

            {/* Stats row */}
            <View style={{ marginHorizontal: 20, marginBottom: 20 }}>
              <Text style={{ fontSize: 9, color: '#695d4a', textTransform: 'uppercase', letterSpacing: 1.5, fontFamily: 'DM-Sans', marginBottom: 10 }}>
                Today's Stats
              </Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {stats.map(s => (
                  <View key={s.label} style={{
                    flex: 1, backgroundColor: '#fff', borderRadius: 8, padding: 14,
                    borderWidth: 0.5, borderColor: '#e3e2e0', alignItems: 'center',
                  }}>
                    <Ionicons name={s.icon as any} size={20} color="#695d4a" />
                    <Text style={{ fontSize: 18, fontWeight: '700', color: '#1a1c1a', fontFamily: 'DM-Sans', marginTop: 6 }}>
                      {s.value}
                    </Text>
                    <Text style={{ fontSize: 9, color: '#747878', textTransform: 'uppercase', letterSpacing: 0.8, fontFamily: 'DM-Sans', marginTop: 2, textAlign: 'center' }}>
                      {s.label}
                    </Text>
                  </View>
                ))}
              </View>
            </View>

            {/* Tasks */}
            <View style={{ marginHorizontal: 20, marginBottom: 32 }}>
              <Text style={{ fontSize: 9, color: '#695d4a', textTransform: 'uppercase', letterSpacing: 1.5, fontFamily: 'DM-Sans', marginBottom: 10 }}>
                Today's Tasks ({summary.tasks.length})
              </Text>
              {summary.tasks.length === 0 ? (
                <View style={{ backgroundColor: '#fff', borderRadius: 8, padding: 24, alignItems: 'center', borderWidth: 0.5, borderColor: '#e3e2e0' }}>
                  <Ionicons name="clipboard-outline" size={28} color="#c4c7c7" />
                  <Text style={{ fontSize: 12, color: '#c4c7c7', fontFamily: 'DM-Sans', marginTop: 8 }}>
                    No tasks scheduled today
                  </Text>
                </View>
              ) : (
                <View style={{ gap: 8 }}>
                  {summary.tasks.map(task => {
                    const c = STATUS_COLORS[task.status] ?? STATUS_COLORS.pending;
                    return (
                      <View key={task.id} style={{ backgroundColor: '#fff', borderRadius: 8, padding: 14, borderWidth: 0.5, borderColor: '#e3e2e0' }}>
                        <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 4 }}>
                          <Text style={{ fontSize: 13, fontWeight: '600', color: '#1a1c1a', fontFamily: 'DM-Sans', flex: 1 }}>
                            {task.title}
                          </Text>
                          <View style={{ backgroundColor: c.bg, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4, marginLeft: 8 }}>
                            <Text style={{ fontSize: 8, color: c.text, fontFamily: 'DM-Sans', fontWeight: '600', letterSpacing: 0.5, textTransform: 'uppercase' }}>
                              {task.status.replace('_', ' ')}
                            </Text>
                          </View>
                        </View>
                        {task.location && (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                            <Ionicons name="location-outline" size={11} color="#747878" />
                            <Text style={{ fontSize: 11, color: '#747878', fontFamily: 'DM-Sans' }} numberOfLines={1}>
                              {task.location}
                            </Text>
                          </View>
                        )}
                        {task.scheduled_time && (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
                            <Ionicons name="time-outline" size={11} color="#747878" />
                            <Text style={{ fontSize: 11, color: '#747878', fontFamily: 'DM-Sans' }}>
                              {formatTime(task.scheduled_time)}
                            </Text>
                          </View>
                        )}
                      </View>
                    );
                  })}
                </View>
              )}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
