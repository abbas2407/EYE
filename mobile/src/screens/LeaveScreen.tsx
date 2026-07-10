import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  TextInput, ActivityIndicator, RefreshControl, Alert, Modal
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { apiFetch } from '../api/client';

interface LeaveScreenProps {
  onBack: () => void;
}

interface Balance {
  sick_days: number;
  casual_days: number;
  annual_days: number;
}

interface LeaveRecord {
  id: string;
  leave_type: string;
  start_date: string;
  end_date: string;
  days: number;
  reason?: string;
  status: string;
}

const STATUS_STYLE: Record<string, { bg: string; text: string }> = {
  pending:  { bg: '#fef3c7', text: '#92400e' },
  approved: { bg: '#dcfce7', text: '#166534' },
  rejected: { bg: '#fee2e2', text: '#991b1b' },
};

export default function LeaveScreen({ onBack }: LeaveScreenProps) {
  const [balance, setBalance] = useState<Balance | null>(null);
  const [leaves, setLeaves] = useState<LeaveRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [applyModal, setApplyModal] = useState(false);
  const [applying, setApplying] = useState(false);

  const [leaveType, setLeaveType] = useState<'sick' | 'casual' | 'annual'>('sick');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState('');

  const fetchData = useCallback(async () => {
    try {
      const [balRes, leavesRes] = await Promise.allSettled([
        apiFetch('/api/leaves/balance'),
        apiFetch('/api/leaves/my-leaves'),
      ]);
      if (balRes.status === 'fulfilled' && balRes.value.ok)
        setBalance(await balRes.value.json());
      if (leavesRes.status === 'fulfilled' && leavesRes.value.ok)
        setLeaves(await leavesRes.value.json());
    } catch {}
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { fetchData(); }, []);

  async function applyLeave() {
    if (!startDate || !endDate) {
      Alert.alert('Missing Fields', 'Please enter start and end dates (YYYY-MM-DD).');
      return;
    }
    setApplying(true);
    try {
      const res = await apiFetch('/api/leaves/apply', {
        method: 'POST',
        body: JSON.stringify({ leave_type: leaveType, start_date: startDate, end_date: endDate, reason }),
      });
      if (res.ok) {
        Alert.alert('Success', 'Leave application submitted.');
        setApplyModal(false);
        setStartDate(''); setEndDate(''); setReason('');
        fetchData();
      } else {
        const err = await res.json().catch(() => ({}));
        Alert.alert('Error', err.detail ?? 'Failed to apply for leave.');
      }
    } catch {
      Alert.alert('Error', 'Network error. Please try again.');
    } finally { setApplying(false); }
  }

  const balanceItems = balance ? [
    { label: 'Sick', days: balance.sick_days, icon: 'medical-outline', color: '#991b1b' },
    { label: 'Casual', days: balance.casual_days, icon: 'sunny-outline', color: '#695d4a' },
    { label: 'Annual', days: balance.annual_days, icon: 'airplane-outline', color: '#166534' },
  ] : [];

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#faf9f6' }} edges={['top']}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchData(); }} tintColor="#695d4a" />}
      >
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12, gap: 12 }}>
          <TouchableOpacity onPress={onBack} style={{ padding: 4 }}>
            <Ionicons name="arrow-back" size={22} color="#1a1c1a" />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 9, color: '#695d4a', textTransform: 'uppercase', letterSpacing: 1.5, fontFamily: 'DM-Sans' }}>
              Leave Management
            </Text>
            <Text style={{ fontSize: 22, fontFamily: 'PlayfairDisplay-Bold', color: '#1a1c1a', marginTop: 2 }}>
              My Leaves
            </Text>
          </View>
          <TouchableOpacity
            onPress={() => setApplyModal(true)}
            style={{ backgroundColor: '#1a1c1a', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 4, flexDirection: 'row', alignItems: 'center', gap: 6 }}
          >
            <Ionicons name="add" size={14} color="#fff" />
            <Text style={{ color: '#fff', fontSize: 11, fontFamily: 'DM-Sans', fontWeight: '500', textTransform: 'uppercase', letterSpacing: 0.8 }}>
              Apply
            </Text>
          </TouchableOpacity>
        </View>

        {loading ? (
          <View style={{ paddingVertical: 60, alignItems: 'center' }}>
            <ActivityIndicator size="large" color="#695d4a" />
          </View>
        ) : (
          <>
            {/* Balance cards */}
            <View style={{ marginHorizontal: 20, marginBottom: 20 }}>
              <Text style={{ fontSize: 9, color: '#695d4a', textTransform: 'uppercase', letterSpacing: 1.5, fontFamily: 'DM-Sans', marginBottom: 10 }}>
                Leave Balance
              </Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {balanceItems.map(b => (
                  <View key={b.label} style={{
                    flex: 1, backgroundColor: '#fff', borderRadius: 8, padding: 14,
                    borderWidth: 0.5, borderColor: '#e3e2e0', alignItems: 'center',
                  }}>
                    <Ionicons name={b.icon as any} size={20} color={b.color} />
                    <Text style={{ fontSize: 22, fontWeight: '700', color: '#1a1c1a', fontFamily: 'DM-Sans', marginTop: 6 }}>
                      {b.days}
                    </Text>
                    <Text style={{ fontSize: 9, color: '#747878', textTransform: 'uppercase', letterSpacing: 0.8, fontFamily: 'DM-Sans', marginTop: 2 }}>
                      {b.label}
                    </Text>
                  </View>
                ))}
              </View>
            </View>

            {/* Leave history */}
            <View style={{ marginHorizontal: 20, marginBottom: 32 }}>
              <Text style={{ fontSize: 9, color: '#695d4a', textTransform: 'uppercase', letterSpacing: 1.5, fontFamily: 'DM-Sans', marginBottom: 10 }}>
                Applications
              </Text>
              {leaves.length === 0 ? (
                <View style={{ backgroundColor: '#fff', borderRadius: 8, padding: 24, alignItems: 'center', borderWidth: 0.5, borderColor: '#e3e2e0' }}>
                  <Ionicons name="document-outline" size={28} color="#c4c7c7" />
                  <Text style={{ fontSize: 12, color: '#c4c7c7', fontFamily: 'DM-Sans', marginTop: 8 }}>
                    No leave applications yet
                  </Text>
                </View>
              ) : (
                <View style={{ gap: 8 }}>
                  {leaves.map(l => {
                    const s = STATUS_STYLE[l.status] ?? STATUS_STYLE.pending;
                    return (
                      <View key={l.id} style={{ backgroundColor: '#fff', borderRadius: 8, padding: 14, borderWidth: 0.5, borderColor: '#e3e2e0' }}>
                        <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 6 }}>
                          <Text style={{ fontSize: 13, fontWeight: '600', color: '#1a1c1a', fontFamily: 'DM-Sans', flex: 1, textTransform: 'capitalize' }}>
                            {l.leave_type} Leave
                          </Text>
                          <View style={{ backgroundColor: s.bg, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4 }}>
                            <Text style={{ fontSize: 8, color: s.text, fontFamily: 'DM-Sans', fontWeight: '600', letterSpacing: 0.5, textTransform: 'uppercase' }}>
                              {l.status}
                            </Text>
                          </View>
                        </View>
                        <Text style={{ fontSize: 11, color: '#747878', fontFamily: 'DM-Sans' }}>
                          {l.start_date} → {l.end_date} ({l.days} day{l.days !== 1 ? 's' : ''})
                        </Text>
                        {l.reason && (
                          <Text style={{ fontSize: 11, color: '#747878', fontFamily: 'DM-Sans', marginTop: 4, fontStyle: 'italic' }}>
                            {l.reason}
                          </Text>
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

      {/* Apply Leave Modal */}
      <Modal visible={applyModal} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setApplyModal(false)}>
        <SafeAreaView style={{ flex: 1, backgroundColor: '#faf9f6' }} edges={['top']}>
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 16, borderBottomWidth: 0.5, borderBottomColor: '#e3e2e0' }}>
            <Text style={{ flex: 1, fontSize: 17, fontWeight: '700', color: '#1a1c1a', fontFamily: 'DM-Sans' }}>Apply for Leave</Text>
            <TouchableOpacity onPress={() => setApplyModal(false)}>
              <Ionicons name="close" size={22} color="#1a1c1a" />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
            {/* Leave type picker */}
            <View>
              <Text style={{ fontSize: 11, color: '#695d4a', fontFamily: 'DM-Sans', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>Leave Type</Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {(['sick', 'casual', 'annual'] as const).map(t => (
                  <TouchableOpacity
                    key={t}
                    onPress={() => setLeaveType(t)}
                    style={{
                      flex: 1, paddingVertical: 10, borderRadius: 6, alignItems: 'center',
                      backgroundColor: leaveType === t ? '#1a1c1a' : '#fff',
                      borderWidth: 0.5, borderColor: leaveType === t ? '#1a1c1a' : '#e3e2e0',
                    }}
                  >
                    <Text style={{ fontSize: 11, color: leaveType === t ? '#fff' : '#747878', fontFamily: 'DM-Sans', textTransform: 'capitalize' }}>
                      {t}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            <View>
              <Text style={{ fontSize: 11, color: '#695d4a', fontFamily: 'DM-Sans', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 }}>Start Date (YYYY-MM-DD)</Text>
              <TextInput
                value={startDate}
                onChangeText={setStartDate}
                placeholder="2025-01-15"
                placeholderTextColor="#c4c7c7"
                style={{ backgroundColor: '#fff', borderRadius: 8, padding: 12, fontSize: 13, fontFamily: 'DM-Sans', color: '#1a1c1a', borderWidth: 0.5, borderColor: '#e3e2e0' }}
              />
            </View>
            <View>
              <Text style={{ fontSize: 11, color: '#695d4a', fontFamily: 'DM-Sans', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 }}>End Date (YYYY-MM-DD)</Text>
              <TextInput
                value={endDate}
                onChangeText={setEndDate}
                placeholder="2025-01-17"
                placeholderTextColor="#c4c7c7"
                style={{ backgroundColor: '#fff', borderRadius: 8, padding: 12, fontSize: 13, fontFamily: 'DM-Sans', color: '#1a1c1a', borderWidth: 0.5, borderColor: '#e3e2e0' }}
              />
            </View>
            <View>
              <Text style={{ fontSize: 11, color: '#695d4a', fontFamily: 'DM-Sans', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 }}>Reason (Optional)</Text>
              <TextInput
                value={reason}
                onChangeText={setReason}
                placeholder="Brief reason for leave..."
                placeholderTextColor="#c4c7c7"
                multiline
                numberOfLines={3}
                style={{ backgroundColor: '#fff', borderRadius: 8, padding: 12, fontSize: 13, fontFamily: 'DM-Sans', color: '#1a1c1a', borderWidth: 0.5, borderColor: '#e3e2e0', minHeight: 80, textAlignVertical: 'top' }}
              />
            </View>
            <TouchableOpacity
              onPress={applyLeave}
              disabled={applying}
              style={{ backgroundColor: '#1a1c1a', borderRadius: 8, paddingVertical: 14, alignItems: 'center', marginTop: 8, opacity: applying ? 0.6 : 1 }}
            >
              {applying ? <ActivityIndicator color="#fff" /> : (
                <Text style={{ color: '#fff', fontSize: 12, fontFamily: 'DM-Sans', fontWeight: '500', textTransform: 'uppercase', letterSpacing: 1 }}>
                  Submit Application
                </Text>
              )}
            </TouchableOpacity>
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}
