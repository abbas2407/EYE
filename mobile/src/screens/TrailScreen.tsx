import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator } from 'react-native';
import MapView, { Polyline, Marker, PROVIDER_GOOGLE } from 'react-native-maps';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { apiFetch } from '../api/client';

interface TrailScreenProps {
  onBack: () => void;
}

async function osrmMatch(pings: Ping[]): Promise<{ latitude: number; longitude: number }[] | null> {
  if (pings.length < 2) return null;
  try {
    const CHUNK = 100;
    const all: { latitude: number; longitude: number }[] = [];
    for (let i = 0; i < pings.length; i += CHUNK - 1) {
      const chunk = pings.slice(i, i + CHUNK);
      if (chunk.length < 2) break;
      const coords = chunk.map(p => `${p.lng},${p.lat}`).join(';');
      const radiuses = chunk.map(() => '100').join(';');
      const url = `https://router.project-osrm.org/match/v1/driving/${coords}?overview=full&geometries=geojson&radiuses=${radiuses}&gaps=ignore&annotations=false`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.code === 'Ok' && data.matchings?.length) {
        data.matchings.forEach((m: any) =>
          m.geometry.coordinates.forEach(([lng, lat]: number[]) =>
            all.push({ latitude: lat, longitude: lng })
          )
        );
      } else {
        chunk.forEach(p => all.push({ latitude: p.lat, longitude: p.lng }));
      }
    }
    return all.length > 1 ? all : null;
  } catch { return null; }
}

interface Ping { lat: number; lng: number; time: string; }
interface TrailEvent {
  type: 'punch_in' | 'punch_out' | 'travel' | 'halt';
  label: string;
  time: string;
  end_time?: string;
  duration_min: number;
  distance_km: number;
  lat: number;
  lng: number;
}
interface TrailStats {
  gps_distance_km: number;
  total_pings: number;
  punch_in: string | null;
  punch_out: string | null;
}

function fmtTime(iso: string) {
  try { return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }); }
  catch { return ''; }
}

function fmtDist(km: number) {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(2)} km`;
}

const EVENT_COLOR: Record<string, string> = {
  punch_in: '#166534', punch_out: '#991b1b', travel: '#695d4a', halt: '#1e40af',
};
const EVENT_BG: Record<string, string> = {
  punch_in: '#dcfce7', punch_out: '#fee2e2', travel: '#f5f4f1', halt: '#dbeafe',
};

export default function TrailScreen({ onBack }: TrailScreenProps) {
  const mapRef = useRef<MapView>(null);
  const [pings, setPings] = useState<Ping[]>([]);
  const [events, setEvents] = useState<TrailEvent[]>([]);
  const [stats, setStats] = useState<TrailStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [roadCoords, setRoadCoords] = useState<{ latitude: number; longitude: number }[] | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(true);
  const lastPingCountRef = useRef(0);

  const fetchTrail = useCallback(async () => {
    try {
      const res = await apiFetch('/api/gps/my-trail');
      if (!res?.ok) return;
      const data = await res.json();
      const newPings: Ping[] = data.pings ?? [];
      setPings(newPings);
      setEvents(data.events ?? []);
      setStats(data.stats ?? null);
      // Fit map on first load
      if (newPings.length > 1 && mapRef.current && lastPingCountRef.current === 0) {
        mapRef.current.fitToCoordinates(
          newPings.map((p: Ping) => ({ latitude: p.lat, longitude: p.lng })),
          { edgePadding: { top: 60, right: 40, bottom: 60, left: 40 }, animated: true }
        );
      }
      // Re-run OSRM only when ping count changes (new GPS points arrived)
      if (newPings.length !== lastPingCountRef.current && newPings.length >= 2) {
        lastPingCountRef.current = newPings.length;
        osrmMatch(newPings).then(matched => {
          if (matched) setRoadCoords(matched);
        });
      }
    } catch {}
    finally { setLoading(false); }
  }, []);

  // Self-rescheduling poll every 15s
  const scheduleNext = useCallback(() => {
    if (!activeRef.current) return;
    pollRef.current = setTimeout(async () => {
      await fetchTrail();
      scheduleNext();
    }, 15000);
  }, [fetchTrail]);

  useEffect(() => {
    activeRef.current = true;
    fetchTrail().then(scheduleNext);
    return () => {
      activeRef.current = false;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, []);

  const rawCoords = pings.map(p => ({ latitude: p.lat, longitude: p.lng }));
  const routeCoords = roadCoords ?? rawCoords;
  const haltEvents = events.filter(e => e.type === 'halt' && e.lat && e.lng);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#faf9f6' }} edges={['top']}>
      {/* Header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12, gap: 12 }}>
        <TouchableOpacity onPress={onBack} style={{ padding: 4 }}>
          <Ionicons name="arrow-back" size={22} color="#1a1c1a" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 9, color: '#695d4a', textTransform: 'uppercase', letterSpacing: 1.5, fontFamily: 'DM-Sans' }}>
            Today's Activity
          </Text>
          <Text style={{ fontSize: 22, fontFamily: 'PlayfairDisplay-Bold', color: '#1a1c1a', marginTop: 2 }}>
            My Trail
          </Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#22c55e' }} />
          <Text style={{ fontSize: 9, color: '#22c55e', fontFamily: 'DM-Sans', fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8 }}>
            Live
          </Text>
        </View>
      </View>

      {loading ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator size="large" color="#695d4a" />
          <Text style={{ marginTop: 12, fontSize: 12, color: '#747878', fontFamily: 'DM-Sans' }}>Loading your trail...</Text>
        </View>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false} style={{ flex: 1 }}>
          {/* Map */}
          <View style={{ height: 280, marginHorizontal: 16, borderRadius: 12, overflow: 'hidden', borderWidth: 0.5, borderColor: '#e3e2e0' }}>
            {rawCoords.length > 0 ? (
              <MapView
                ref={mapRef}
                provider={PROVIDER_GOOGLE}
                style={{ flex: 1 }}
                initialRegion={{
                  latitude: rawCoords[0]?.latitude ?? 17.385,
                  longitude: rawCoords[0]?.longitude ?? 78.4867,
                  latitudeDelta: 0.05,
                  longitudeDelta: 0.05,
                }}
                showsUserLocation
                showsMyLocationButton={false}
                scrollEnabled
                zoomEnabled
              >
                {/* Raw grey dashed line shown before OSRM completes */}
                {!roadCoords && rawCoords.length >= 2 && (
                  <Polyline coordinates={rawCoords} strokeColor="#c4c7c7" strokeWidth={3} lineDashPattern={[6, 4]} />
                )}
                {/* Road-snapped orange route */}
                {routeCoords.length >= 2 && roadCoords && (
                  <>
                    <Polyline coordinates={routeCoords} strokeColor="#ffffff" strokeWidth={7} />
                    <Polyline coordinates={routeCoords} strokeColor="#FF6D00" strokeWidth={4} />
                  </>
                )}
                {/* Start marker — green (always at first raw ping) */}
                <Marker coordinate={rawCoords[0]} anchor={{ x: 0.5, y: 0.5 }}>
                  <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: '#22c55e', borderWidth: 2.5, borderColor: '#fff' }} />
                </Marker>
                {/* End / current position — red (always at last raw ping) */}
                <Marker coordinate={rawCoords[rawCoords.length - 1]} anchor={{ x: 0.5, y: 0.5 }}>
                  <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: '#ef4444', borderWidth: 2.5, borderColor: '#fff' }} />
                </Marker>
                {/* Halt markers — blue */}
                {haltEvents.map((e, i) => (
                  <Marker key={i} coordinate={{ latitude: e.lat, longitude: e.lng }} anchor={{ x: 0.5, y: 0.5 }}>
                    <View style={{ backgroundColor: '#1e40af', paddingHorizontal: 6, paddingVertical: 3, borderRadius: 10, borderWidth: 1.5, borderColor: '#fff' }}>
                      <Text style={{ color: '#fff', fontSize: 9, fontWeight: '700' }}>{e.duration_min}m</Text>
                    </View>
                  </Marker>
                ))}
              </MapView>
            ) : (
              <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#f5f4f1' }}>
                <Ionicons name="navigate-outline" size={36} color="#c4c7c7" />
                <Text style={{ fontSize: 12, color: '#c4c7c7', fontFamily: 'DM-Sans', marginTop: 10, textAlign: 'center' }}>
                  No GPS data yet today.{'\n'}Start moving to see your trail.
                </Text>
              </View>
            )}
          </View>

          {/* Stats row */}
          {stats && (
            <View style={{ flexDirection: 'row', gap: 8, marginHorizontal: 16, marginTop: 12 }}>
              {[
                { icon: 'navigate-outline', label: 'Distance', value: fmtDist(stats.gps_distance_km), color: '#1a6ef2' },
                { icon: 'pause-circle-outline', label: 'Halts', value: String(haltEvents.length), color: '#1e40af' },
                { icon: 'location-outline', label: 'GPS Points', value: String(stats.total_pings), color: '#695d4a' },
              ].map(s => (
                <View key={s.label} style={{ flex: 1, backgroundColor: '#fff', borderRadius: 8, padding: 12, borderWidth: 0.5, borderColor: '#e3e2e0', alignItems: 'center' }}>
                  <Ionicons name={s.icon as any} size={18} color={s.color} />
                  <Text style={{ fontSize: 16, fontWeight: '700', color: '#1a1c1a', fontFamily: 'DM-Sans', marginTop: 4 }}>{s.value}</Text>
                  <Text style={{ fontSize: 9, color: '#747878', textTransform: 'uppercase', letterSpacing: 0.8, fontFamily: 'DM-Sans', marginTop: 1, textAlign: 'center' }}>{s.label}</Text>
                </View>
              ))}
            </View>
          )}

          {/* Punch times */}
          {stats && (stats.punch_in || stats.punch_out) && (
            <View style={{ flexDirection: 'row', gap: 8, marginHorizontal: 16, marginTop: 8 }}>
              {stats.punch_in && (
                <View style={{ flex: 1, backgroundColor: '#dcfce7', borderRadius: 8, padding: 10, borderWidth: 0.5, borderColor: '#86efac' }}>
                  <Text style={{ fontSize: 9, color: '#166534', textTransform: 'uppercase', letterSpacing: 0.8, fontFamily: 'DM-Sans' }}>Punch In</Text>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: '#166534', fontFamily: 'DM-Sans', marginTop: 2 }}>{fmtTime(stats.punch_in)}</Text>
                </View>
              )}
              {stats.punch_out && (
                <View style={{ flex: 1, backgroundColor: '#fee2e2', borderRadius: 8, padding: 10, borderWidth: 0.5, borderColor: '#fca5a5' }}>
                  <Text style={{ fontSize: 9, color: '#991b1b', textTransform: 'uppercase', letterSpacing: 0.8, fontFamily: 'DM-Sans' }}>Punch Out</Text>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: '#991b1b', fontFamily: 'DM-Sans', marginTop: 2 }}>{fmtTime(stats.punch_out)}</Text>
                </View>
              )}
            </View>
          )}

          {/* Timeline events */}
          <View style={{ marginHorizontal: 16, marginTop: 16, marginBottom: 32 }}>
            <Text style={{ fontSize: 9, color: '#695d4a', textTransform: 'uppercase', letterSpacing: 1.5, fontFamily: 'DM-Sans', marginBottom: 10 }}>
              Activity Timeline
            </Text>
            {events.length === 0 ? (
              <View style={{ backgroundColor: '#fff', borderRadius: 8, padding: 24, alignItems: 'center', borderWidth: 0.5, borderColor: '#e3e2e0' }}>
                <Ionicons name="time-outline" size={28} color="#c4c7c7" />
                <Text style={{ fontSize: 12, color: '#c4c7c7', fontFamily: 'DM-Sans', marginTop: 8, textAlign: 'center' }}>
                  No activity recorded yet
                </Text>
              </View>
            ) : (
              <View>
                {events.map((e, i) => {
                  const clr = EVENT_COLOR[e.type] ?? '#747878';
                  const bg = EVENT_BG[e.type] ?? '#f5f4f1';
                  const isLast = i === events.length - 1;
                  return (
                    <View key={i} style={{ flexDirection: 'row', gap: 12 }}>
                      {/* Dot + line */}
                      <View style={{ alignItems: 'center', width: 20 }}>
                        <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: clr, marginTop: 10, borderWidth: 2, borderColor: '#fff', shadowColor: clr, shadowOpacity: 0.4, shadowRadius: 4, elevation: 2 }} />
                        {!isLast && <View style={{ width: 2, flex: 1, backgroundColor: '#e3e2e0', marginTop: 4 }} />}
                      </View>
                      {/* Content */}
                      <View style={{ flex: 1, paddingBottom: isLast ? 0 : 14, paddingTop: 6 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <View style={{ backgroundColor: bg, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4 }}>
                            <Text style={{ fontSize: 11, fontWeight: '700', color: clr, fontFamily: 'DM-Sans' }}>{e.label}</Text>
                          </View>
                          {e.type === 'travel' && e.distance_km > 0 && (
                            <Text style={{ fontSize: 10, color: '#747878', fontFamily: 'DM-Sans' }}>{fmtDist(e.distance_km)}</Text>
                          )}
                          {e.type === 'halt' && e.duration_min > 0 && (
                            <Text style={{ fontSize: 10, color: '#747878', fontFamily: 'DM-Sans' }}>{e.duration_min} min</Text>
                          )}
                        </View>
                        <Text style={{ fontSize: 11, color: '#c4c7c7', fontFamily: 'DM-Sans', marginTop: 3 }}>
                          {fmtTime(e.time)}{e.end_time ? ` → ${fmtTime(e.end_time)}` : ''}
                        </Text>
                      </View>
                    </View>
                  );
                })}
              </View>
            )}
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
