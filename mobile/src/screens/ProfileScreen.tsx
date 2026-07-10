import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl, Alert
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { apiFetch, getUserName, getUserRole } from '../api/client';

interface ProfileScreenProps {
  onSignOut: () => void;
}

interface AttendanceLog {
  id: string;
  punch_in_time: string;
  punch_out_time?: string;
  total_hours?: number;
  status: string;
}

interface ProfileStats {
  total_shifts: number;
  km_this_month: number;
  tasks_completed: number;
}

function formatDateTime(isoString?: string): string {
  if (!isoString) return '--';
  try {
    return new Date(isoString).toLocaleString('en-IN', {
      day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit', hour12: true,
    });
  } catch {
    return '--';
  }
}

function formatHours(hours?: number): string {
  if (!hours) return '--';
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${h}h ${m}m`;
}

export default function ProfileScreen({ onSignOut }: ProfileScreenProps) {
  const [userName, setUserName] = useState('');
  const [userRole, setUserRole] = useState('');
  const [logs, setLogs] = useState<AttendanceLog[]>([]);
  const [stats, setStats] = useState<ProfileStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    getUserName().then(n => setUserName(n ?? 'Team Member'));
    getUserRole().then(r => setUserRole(r ?? 'field_worker'));
    fetchData();
  }, []);

  const fetchData = useCallback(async () => {
    try {
      const [logsRes, statsRes] = await Promise.allSettled([
        apiFetch('/api/attendance/logs?limit=10'),
        apiFetch('/api/profile/stats'),
      ]);

      if (logsRes.status === 'fulfilled' && logsRes.value.ok) {
        const data = await logsRes.value.json();
        setLogs(Array.isArray(data) ? data : data.logs ?? []);
      }

      if (statsRes.status === 'fulfilled' && statsRes.value.ok) {
        const data = await statsRes.value.json();
        setStats(data);
      }
    } catch {}
    finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const onRefresh = () => {
    setRefreshing(true);
    fetchData();
  };

  function handleSignOut() {
    Alert.alert(
      'Sign Out',
      'Are you sure you want to sign out?',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign Out', style: 'destructive', onPress: onSignOut },
      ]
    );
  }

  const roleLabelMap: Record<string, string> = {
    field_worker: 'Field Worker',
    admin: 'Admin',
    manager: 'Manager',
    supervisor: 'Supervisor',
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#faf9f6' }} edges={['top']}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#695d4a" />}
      >
        {/* Header */}
        <View style={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 }}>
          <Text style={{ fontSize: 9, color: '#695d4a', textTransform: 'uppercase', letterSpacing: 1.5, fontFamily: 'DM-Sans' }}>
            Account
          </Text>
          <Text style={{ fontSize: 26, fontFamily: 'PlayfairDisplay-Bold', color: '#1a1c1a', marginTop: 2 }}>
            Profile
          </Text>
        </View>

        {/* Profile card */}
        <View style={{ marginHorizontal: 20, marginVertical: 12 }}>
          <View style={{ backgroundColor: '#1a1c1a', borderRadius: 12, padding: 20 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
              <View style={{
                width: 52, height: 52, borderRadius: 26,
                backgroundColor: '#695d4a',
                justifyContent: 'center', alignItems: 'center',
              }}>
                <Text style={{ fontSize: 20, fontWeight: '700', color: '#fff', fontFamily: 'DM-Sans' }}>
                  {userName.charAt(0).toUpperCase()}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 17, fontWeight: '700', color: '#fff', fontFamily: 'DM-Sans' }}>
                  {userName}
                </Text>
                <View style={{
                  marginTop: 4, backgroundColor: '#f2e0c8', alignSelf: 'flex-start',
                  paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4,
                }}>
                  <Text style={{ fontSize: 9, color: '#695d4a', fontFamily: 'DM-Sans', fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8 }}>
                    {roleLabelMap[userRole] ?? userRole}
                  </Text>
                </View>
              </View>
            </View>
          </View>
        </View>

        {/* Stats row */}
        <View style={{ marginHorizontal: 20, marginBottom: 16 }}>
          <Text style={{ fontSize: 9, color: '#695d4a', textTransform: 'uppercase', letterSpacing: 1.5, fontFamily: 'DM-Sans', marginBottom: 10 }}>
            This Month
          </Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {[
              { label: 'Shifts', value: stats?.total_shifts?.toString() ?? '--', icon: 'calendar-outline' },
              { label: 'KM', value: stats?.km_this_month ? `${stats.km_this_month.toFixed(0)}` : '--', icon: 'map-outline' },
              { label: 'Tasks', value: stats?.tasks_completed?.toString() ?? '--', icon: 'checkmark-circle-outline' },
            ].map(item => (
              <View key={item.label} style={{
                flex: 1, backgroundColor: '#fff', borderRadius: 8, padding: 14,
                borderWidth: 0.5, borderColor: '#e3e2e0', alignItems: 'center',
              }}>
                <Ionicons name={item.icon as any} size={20} color="#695d4a" />
                <Text style={{ fontSize: 20, fontWeight: '700', color: '#1a1c1a', fontFamily: 'DM-Sans', marginTop: 6 }}>
                  {item.value}
                </Text>
                <Text style={{ fontSize: 9, color: '#747878', textTransform: 'uppercase', letterSpacing: 0.8, fontFamily: 'DM-Sans', marginTop: 2 }}>
                  {item.label}
                </Text>
              </View>
            ))}
          </View>
        </View>

        {/* Attendance history */}
        <View style={{ marginHorizontal: 20, marginBottom: 16 }}>
          <Text style={{ fontSize: 9, color: '#695d4a', textTransform: 'uppercase', letterSpacing: 1.5, fontFamily: 'DM-Sans', marginBottom: 10 }}>
            Recent Shifts
          </Text>
          {loading ? (
            <View style={{ paddingVertical: 24, alignItems: 'center' }}>
              <ActivityIndicator size="small" color="#695d4a" />
            </View>
          ) : logs.length === 0 ? (
            <View style={{ backgroundColor: '#fff', borderRadius: 8, padding: 20, alignItems: 'center', borderWidth: 0.5, borderColor: '#e3e2e0' }}>
              <Ionicons name="time-outline" size={28} color="#c4c7c7" />
              <Text style={{ fontSize: 12, color: '#c4c7c7', fontFamily: 'DM-Sans', marginTop: 8 }}>
                No attendance records yet.
              </Text>
            </View>
          ) : (
            <View style={{ gap: 6 }}>
              {logs.map((log, idx) => (
                <View
                  key={log.id ?? idx}
                  style={{
                    backgroundColor: '#fff', borderRadius: 8, padding: 14,
                    borderWidth: 0.5, borderColor: '#e3e2e0',
                    flexDirection: 'row', alignItems: 'center', gap: 12,
                  }}
                >
                  <View style={{
                    width: 36, height: 36, borderRadius: 18,
                    backgroundColor: log.punch_out_time ? '#dcfce7' : '#fef3c7',
                    justifyContent: 'center', alignItems: 'center',
                  }}>
                    <Ionicons
                      name={log.punch_out_time ? 'checkmark-circle-outline' : 'time-outline'}
                      size={18}
                      color={log.punch_out_time ? '#166534' : '#92400e'}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 12, fontWeight: '600', color: '#1a1c1a', fontFamily: 'DM-Sans' }}>
                      {formatDateTime(log.punch_in_time)}
                    </Text>
                    <Text style={{ fontSize: 10, color: '#747878', fontFamily: 'DM-Sans', marginTop: 1 }}>
                      {log.punch_out_time ? `Out: ${formatDateTime(log.punch_out_time)}` : 'Active shift'}
                    </Text>
                  </View>
                  {log.total_hours && (
                    <Text style={{ fontSize: 12, fontWeight: '600', color: '#695d4a', fontFamily: 'DM-Sans' }}>
                      {formatHours(log.total_hours)}
                    </Text>
                  )}
                </View>
              ))}
            </View>
          )}
        </View>

        {/* Settings */}
        <View style={{ marginHorizontal: 20, marginBottom: 32 }}>
          <Text style={{ fontSize: 9, color: '#695d4a', textTransform: 'uppercase', letterSpacing: 1.5, fontFamily: 'DM-Sans', marginBottom: 10 }}>
            Settings
          </Text>
          <View style={{ backgroundColor: '#fff', borderRadius: 8, borderWidth: 0.5, borderColor: '#e3e2e0', overflow: 'hidden' }}>
            {[
              { icon: 'notifications-outline', label: 'Notifications', action: () => {} },
              { icon: 'shield-checkmark-outline', label: 'Privacy Policy', action: () => {} },
              { icon: 'help-circle-outline', label: 'Help & Support', action: () => {} },
            ].map((item, idx, arr) => (
              <TouchableOpacity
                key={item.label}
                onPress={item.action}
                style={{
                  flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14,
                  borderBottomWidth: idx < arr.length - 1 ? 0.5 : 0, borderBottomColor: '#efeeeb', gap: 12,
                }}
              >
                <Ionicons name={item.icon as any} size={18} color="#695d4a" />
                <Text style={{ flex: 1, fontSize: 13, color: '#1a1c1a', fontFamily: 'DM-Sans' }}>
                  {item.label}
                </Text>
                <Ionicons name="chevron-forward" size={14} color="#c4c7c7" />
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Sign out */}
        <View style={{ marginHorizontal: 20, marginBottom: 40 }}>
          <TouchableOpacity
            onPress={handleSignOut}
            style={{
              borderWidth: 1, borderColor: '#ba1a1a', borderRadius: 8, paddingVertical: 14,
              alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8,
            }}
          >
            <Ionicons name="log-out-outline" size={18} color="#ba1a1a" />
            <Text style={{ fontSize: 12, color: '#ba1a1a', fontFamily: 'DM-Sans', fontWeight: '500', textTransform: 'uppercase', letterSpacing: 1 }}>
              Sign Out
            </Text>
          </TouchableOpacity>
          <Text style={{ fontSize: 10, color: '#c4c7c7', textAlign: 'center', marginTop: 12, fontFamily: 'DM-Sans' }}>
            FieldPulse v1.0.0
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
