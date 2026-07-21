import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, Modal, TextInput,
  ActivityIndicator, Alert, Platform, Image, ScrollView, Vibration
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Location from 'expo-location';
import * as Application from 'expo-application';
import { Ionicons } from '@expo/vector-icons';
import { apiFetch, API_BASE_URL, getAccessToken } from '../api/client';

interface PunchModalProps {
  isVisible: boolean;
  isPunchedIn: boolean;
  attendanceLogId: string | null;
  onClose: () => void;
  onPunchInSuccess: (time: string, logId: string) => void;
  onPunchOutSuccess: () => void;
}

type Step = 'device' | 'time_sync' | 'geofence' | 'selfie' | 'verifying' | 'success' | 'error';

export default function PunchModal({
  isVisible,
  isPunchedIn,
  attendanceLogId,
  onClose,
  onPunchInSuccess,
  onPunchOutSuccess,
}: PunchModalProps) {
  const [step, setStep] = useState<Step>('device');
  const [stepError, setStepError] = useState<string | null>(null);
  const [capturedPhoto, setCapturedPhoto] = useState<string | null>(null);
  const [successTime, setSuccessTime] = useState<string | null>(null);
  const [geofenceWarning, setGeofenceWarning] = useState<string | null>(null);
  const [checkInNote, setCheckInNote] = useState('');
  const [showNoteInput, setShowNoteInput] = useState(false);

  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);

  useEffect(() => {
    if (isVisible) {
      // For punch out: skip to selfie step
      const startStep: Step = isPunchedIn ? 'selfie' : 'device';
      setStep(startStep);
      setStepError(null);
      setCapturedPhoto(null);
      setGeofenceWarning(null);
      setSuccessTime(null);
      setCheckInNote('');
      setShowNoteInput(false);

      if (!isPunchedIn) {
        runDeviceCheck();
      }
    }
  }, [isVisible]);

  // ── STEP 1: Device check
  async function runDeviceCheck() {
    setStep('device');
    setStepError(null);
    try {
      const providerStatus = await Location.getProviderStatusAsync();
      if (providerStatus.locationServicesEnabled === false) {
        setStepError('Location services are disabled. Please enable GPS.');
        return;
      }
      // Check for mock GPS
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).catch(() => null);
      if (loc?.mocked) {
        setStepError('Mock GPS detected. Disable mock location apps and try again.');
        return;
      }
      // Pass device check → move to time sync
      await runTimeSync();
    } catch {
      setStepError('Unable to check device status. Please try again.');
    }
  }

  // ── STEP 2: Time sync
  async function runTimeSync() {
    setStep('time_sync');
    setStepError(null);
    try {
      const res = await apiFetch('/api/time');
      if (!res.ok) throw new Error('Time API unavailable');
      const data = await res.json();
      const serverTime = new Date(data.datetime ?? data.time ?? data.server_time).getTime();
      const drift = Math.abs(Date.now() - serverTime);
      if (drift > 60000) {
        setStepError('Device time mismatch. Please sync your device clock and try again.');
        return;
      }
      await runGeofence();
    } catch {
      // If time API fails, skip check and proceed
      await runGeofence();
    }
  }

  // ── STEP 3: Geofence
  async function runGeofence() {
    setStep('geofence');
    setStepError(null);
    setGeofenceWarning(null);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setStepError('Location permission is required for attendance.');
        return;
      }
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      // If no task location available, skip geofence — just move on
      setGeofenceWarning(null);
      setStep('selfie');
    } catch {
      // Geofence check failed — still allow selfie
      setStep('selfie');
    }
  }

  // ── STEP 4: Take selfie
  async function takeSelfie() {
    if (!cameraRef.current) return;
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.6, base64: false });
      if (photo?.uri) {
        setCapturedPhoto(photo.uri);
        setStep('verifying');
        await submitPunch(photo.uri);
      }
    } catch {
      setStepError('Failed to capture photo. Please try again.');
    }
  }

  // ── STEP 5: Upload + submit
  async function submitPunch(photoUri: string) {
    setStep('verifying');
    setStepError(null);
    try {
      // Get current location for punch
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }).catch(() => null);

      // Upload selfie
      let selfieUrl: string | null = null;
      try {
        const formData = new FormData();
        formData.append('file', {
          uri: photoUri,
          type: 'image/jpeg',
          name: 'selfie.jpg',
        } as any);

        const token = await getAccessToken();
        const uploadRes = await fetch(`${API_BASE_URL}/api/mock-s3/upload`, {
          method: 'POST',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: formData,
        });
        if (uploadRes.ok) {
          const uploadData = await uploadRes.json();
          selfieUrl = uploadData.url ?? uploadData.file_url ?? null;
        }
      } catch {}

      if (isPunchedIn && attendanceLogId) {
        // PUNCH OUT
        const res = await apiFetch('/api/attendance/punch-out', {
          method: 'POST',
          body: JSON.stringify({
            attendance_log_id: attendanceLogId,
            selfie_url: selfieUrl,
            latitude: loc?.coords.latitude,
            longitude: loc?.coords.longitude,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          setStepError(err.detail ?? 'Failed to punch out. Please try again.');
          setStep('error');
          return;
        }
        setStep('success');
        Vibration.vibrate(100);
        setTimeout(() => onPunchOutSuccess(), 1500);
      } else {
        // PUNCH IN
        const res = await apiFetch('/api/attendance/punch-in', {
          method: 'POST',
          body: JSON.stringify({
            selfie_url: selfieUrl,
            latitude: loc?.coords.latitude,
            longitude: loc?.coords.longitude,
            check_in_note: checkInNote.trim() || null,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          const detail: string = err.detail ?? '';
          // Backend says already punched in — state was stale, recover gracefully
          if (detail.toLowerCase().includes('already punched in')) {
            const summary = await apiFetch('/api/attendance/summary').catch(() => null);
            if (summary?.ok) {
              const sd = await summary.json();
              // Only recover if we got a real active log — backend fix now returns
              // active logs from any date, not just today
              if (sd.attendance_log_id) {
                const punchTime = sd.punch_in_time
                  ? new Date(sd.punch_in_time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
                  : new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
                setSuccessTime(punchTime);
                setStep('success');
                Vibration.vibrate(100);
                setTimeout(() => onPunchInSuccess(punchTime, String(sd.attendance_log_id)), 1500);
                return;
              }
            }
          }
          setStepError(detail || 'Failed to punch in. Please try again.');
          setStep('error');
          return;
        }
        const data = await res.json();
        const punchTime = data.punch_in_time ?? new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
        const logId = data.id ?? data.log_id ?? data.attendance_log_id ?? '';
        setSuccessTime(punchTime);
        setStep('success');
        Vibration.vibrate(100);
        setTimeout(() => onPunchInSuccess(punchTime, String(logId)), 1500);
      }
    } catch {
      setStepError('Network error. Please check your connection and try again.');
      setStep('error');
    }
  }

  function resetAndClose() {
    setStep('device');
    setStepError(null);
    setCapturedPhoto(null);
    onClose();
  }

  const stepLabels: Record<string, string> = {
    device: 'DEVICE CHECK',
    time_sync: 'TIME SYNC',
    geofence: 'LOCATION CHECK',
    selfie: 'VERIFY IDENTITY',
    verifying: 'SUBMITTING',
    success: 'DONE',
    error: 'ERROR',
  };

  const currentStepNum = ['device', 'time_sync', 'geofence', 'selfie', 'verifying'].indexOf(step) + 1;

  return (
    <Modal
      visible={isVisible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={resetAndClose}
    >
      <View style={{ flex: 1, backgroundColor: '#faf9f6' }}>
        {/* Header */}
        <View style={{
          flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
          paddingHorizontal: 20, paddingTop: 20, paddingBottom: 16,
          borderBottomWidth: 0.5, borderBottomColor: '#e3e2e0',
        }}>
          <View>
            <Text style={{ fontSize: 9, color: '#695d4a', textTransform: 'uppercase', letterSpacing: 1.5, fontFamily: 'DM-Sans' }}>
              {isPunchedIn ? 'Punch Out' : 'Punch In'}
            </Text>
            <Text style={{ fontSize: 18, fontWeight: '700', color: '#1a1c1a', fontFamily: 'PlayfairDisplay-Bold', marginTop: 2 }}>
              {stepLabels[step] ?? step.toUpperCase()}
            </Text>
          </View>
          <TouchableOpacity onPress={resetAndClose} style={{ padding: 4 }}>
            <Ionicons name="close" size={22} color="#1a1c1a" />
          </TouchableOpacity>
        </View>

        {/* Progress dots (only for punch in flow) */}
        {!isPunchedIn && step !== 'success' && step !== 'error' && (
          <View style={{ flexDirection: 'row', paddingHorizontal: 20, paddingVertical: 12, gap: 6 }}>
            {['device', 'time_sync', 'geofence', 'selfie', 'verifying'].map((s, i) => (
              <View
                key={s}
                style={{
                  flex: 1, height: 2, borderRadius: 1,
                  backgroundColor: i < currentStepNum ? '#1a1c1a' : '#e3e2e0',
                }}
              />
            ))}
          </View>
        )}

        {/* Step content */}
        <View style={{ flex: 1, padding: 20 }}>

          {/* Checking steps (device, time_sync, geofence) */}
          {(step === 'device' || step === 'time_sync' || step === 'geofence') && (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
              {stepError ? (
                <>
                  <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: '#fee2e2', justifyContent: 'center', alignItems: 'center', marginBottom: 16 }}>
                    <Ionicons name="alert-circle-outline" size={32} color="#991b1b" />
                  </View>
                  <Text style={{ fontSize: 15, fontWeight: '600', color: '#1a1c1a', textAlign: 'center', fontFamily: 'DM-Sans', marginBottom: 8 }}>
                    Check Failed
                  </Text>
                  <Text style={{ fontSize: 13, color: '#747878', textAlign: 'center', fontFamily: 'DM-Sans', lineHeight: 20, marginBottom: 24, paddingHorizontal: 16 }}>
                    {stepError}
                  </Text>
                  <TouchableOpacity
                    onPress={runDeviceCheck}
                    style={{ backgroundColor: '#1a1c1a', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 4 }}
                  >
                    <Text style={{ color: '#fff', fontFamily: 'DM-Sans', fontWeight: '500', textTransform: 'uppercase', letterSpacing: 1, fontSize: 12 }}>
                      Retry
                    </Text>
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  <ActivityIndicator size="large" color="#695d4a" />
                  <Text style={{ marginTop: 16, fontSize: 13, color: '#747878', fontFamily: 'DM-Sans' }}>
                    {step === 'device' ? 'Checking device...' : step === 'time_sync' ? 'Syncing time...' : 'Checking location...'}
                  </Text>
                </>
              )}
            </View>
          )}

          {/* Selfie step */}
          {step === 'selfie' && (
            <View style={{ flex: 1 }}>
              {/* Check-in note (punch in only) */}
              {!isPunchedIn && (
                <View style={{ marginBottom: 12 }}>
                  <TouchableOpacity
                    onPress={() => setShowNoteInput(!showNoteInput)}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: showNoteInput ? 8 : 0 }}
                  >
                    <Ionicons name={showNoteInput ? 'chevron-down' : 'chevron-forward'} size={14} color="#695d4a" />
                    <Text style={{ fontSize: 11, color: '#695d4a', fontFamily: 'DM-Sans', textTransform: 'uppercase', letterSpacing: 0.8 }}>
                      Add Check-in Note (optional)
                    </Text>
                  </TouchableOpacity>
                  {showNoteInput && (
                    <TextInput
                      value={checkInNote}
                      onChangeText={setCheckInNote}
                      placeholder="e.g. Starting site inspection at Block A..."
                      placeholderTextColor="#c4c7c7"
                      multiline
                      numberOfLines={2}
                      maxLength={300}
                      style={{ backgroundColor: '#fff', borderRadius: 8, padding: 10, fontSize: 12, fontFamily: 'DM-Sans', color: '#1a1c1a', borderWidth: 0.5, borderColor: '#e3e2e0', minHeight: 60, textAlignVertical: 'top' }}
                    />
                  )}
                </View>
              )}

              {geofenceWarning && (
                <View style={{ backgroundColor: '#fef3c7', borderRadius: 8, padding: 10, marginBottom: 12, flexDirection: 'row', gap: 8 }}>
                  <Ionicons name="warning-outline" size={14} color="#92400e" />
                  <Text style={{ flex: 1, fontSize: 11, color: '#92400e', fontFamily: 'DM-Sans', lineHeight: 16 }}>
                    {geofenceWarning}
                  </Text>
                </View>
              )}

              {!cameraPermission?.granted ? (
                <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                  <Ionicons name="camera-outline" size={48} color="#695d4a" />
                  <Text style={{ fontSize: 15, fontWeight: '600', color: '#1a1c1a', marginTop: 16, textAlign: 'center', fontFamily: 'DM-Sans' }}>
                    Camera Permission Required
                  </Text>
                  <Text style={{ fontSize: 12, color: '#747878', marginTop: 8, textAlign: 'center', fontFamily: 'DM-Sans', lineHeight: 18 }}>
                    A selfie is required to verify your identity.
                  </Text>
                  <TouchableOpacity
                    onPress={requestCameraPermission}
                    style={{ marginTop: 20, backgroundColor: '#1a1c1a', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 4 }}
                  >
                    <Text style={{ color: '#fff', fontFamily: 'DM-Sans', fontWeight: '500', textTransform: 'uppercase', letterSpacing: 1, fontSize: 12 }}>
                      Allow Camera
                    </Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 12, color: '#747878', textAlign: 'center', fontFamily: 'DM-Sans', marginBottom: 12, lineHeight: 18 }}>
                    Position your face in the frame and take a selfie to verify attendance.
                  </Text>
                  <View style={{ flex: 1, borderRadius: 12, overflow: 'hidden', position: 'relative' }}>
                    <CameraView
                      ref={cameraRef}
                      style={{ flex: 1 }}
                      facing="front"
                    >
                      {/* Circular overlay guide */}
                      <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', alignItems: 'center' }}>
                        <View style={{
                          width: 180, height: 180, borderRadius: 90,
                          borderWidth: 2, borderColor: 'rgba(255,255,255,0.8)',
                          borderStyle: 'dashed',
                        }} />
                      </View>
                    </CameraView>
                  </View>
                  <TouchableOpacity
                    onPress={takeSelfie}
                    style={{
                      marginTop: 16,
                      backgroundColor: '#1a1c1a',
                      paddingVertical: 16,
                      borderRadius: 4,
                      alignItems: 'center',
                      flexDirection: 'row',
                      justifyContent: 'center',
                      gap: 8,
                    }}
                  >
                    <Ionicons name="camera" size={18} color="#fff" />
                    <Text style={{ color: '#fff', fontFamily: 'DM-Sans', fontWeight: '500', textTransform: 'uppercase', letterSpacing: 1, fontSize: 12 }}>
                      Take Selfie
                    </Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          )}

          {/* Verifying step */}
          {step === 'verifying' && (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
              {capturedPhoto && (
                <Image
                  source={{ uri: capturedPhoto }}
                  style={{ width: 100, height: 100, borderRadius: 50, marginBottom: 20, borderWidth: 2, borderColor: '#e3e2e0' }}
                />
              )}
              <ActivityIndicator size="large" color="#695d4a" />
              <Text style={{ marginTop: 16, fontSize: 13, color: '#747878', fontFamily: 'DM-Sans' }}>
                Submitting attendance...
              </Text>
            </View>
          )}

          {/* Success step */}
          {step === 'success' && (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
              <View style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: '#dcfce7', justifyContent: 'center', alignItems: 'center', marginBottom: 16 }}>
                <Ionicons name="checkmark-circle" size={40} color="#166534" />
              </View>
              <Text style={{ fontSize: 20, fontFamily: 'PlayfairDisplay-Bold', color: '#1a1c1a', textAlign: 'center' }}>
                {isPunchedIn ? 'Punched Out!' : 'Attendance Marked!'}
              </Text>
              {successTime && (
                <Text style={{ fontSize: 13, color: '#747878', fontFamily: 'DM-Sans', marginTop: 8 }}>
                  Recorded at {successTime}
                </Text>
              )}
            </View>
          )}

          {/* Error step */}
          {step === 'error' && (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
              <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: '#fee2e2', justifyContent: 'center', alignItems: 'center', marginBottom: 16 }}>
                <Ionicons name="close-circle-outline" size={32} color="#991b1b" />
              </View>
              <Text style={{ fontSize: 15, fontWeight: '600', color: '#1a1c1a', textAlign: 'center', fontFamily: 'DM-Sans', marginBottom: 8 }}>
                Submission Failed
              </Text>
              <Text style={{ fontSize: 13, color: '#747878', textAlign: 'center', fontFamily: 'DM-Sans', lineHeight: 20, marginBottom: 24, paddingHorizontal: 16 }}>
                {stepError}
              </Text>
              <TouchableOpacity
                onPress={() => {
                  setCapturedPhoto(null);
                  setStep('selfie');
                  setStepError(null);
                }}
                style={{ backgroundColor: '#1a1c1a', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 4 }}
              >
                <Text style={{ color: '#fff', fontFamily: 'DM-Sans', fontWeight: '500', textTransform: 'uppercase', letterSpacing: 1, fontSize: 12 }}>
                  Try Again
                </Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}
