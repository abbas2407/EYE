import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  ActivityIndicator, Platform, Keyboard
} from 'react-native';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import * as Location from 'expo-location';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { apiFetch } from '../api/client';

const GOOGLE_MAPS_API_KEY = 'AIzaSyAJHF-B2ulEDrxStgKH4NS7szhFdjErnos';
const GPS_QUEUE_KEY = 'gps_offline_queue';
const ARRIVAL_THRESHOLD_KM = 0.05;

interface GPSPingItem {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  timestamp: string;
}

async function queueGPSPing(ping: GPSPingItem) {
  try {
    const raw = await AsyncStorage.getItem(GPS_QUEUE_KEY);
    const queue: GPSPingItem[] = raw ? JSON.parse(raw) : [];
    queue.push(ping);
    if (queue.length > 500) queue.splice(0, queue.length - 500);
    await AsyncStorage.setItem(GPS_QUEUE_KEY, JSON.stringify(queue));
  } catch {}
}

async function flushGPSQueue() {
  try {
    const raw = await AsyncStorage.getItem(GPS_QUEUE_KEY);
    if (!raw) return;
    const queue: GPSPingItem[] = JSON.parse(raw);
    if (!queue.length) return;
    const res = await apiFetch('/api/gps/batch', { method: 'POST', body: JSON.stringify({ pings: queue }) });
    if (res?.ok) await AsyncStorage.removeItem(GPS_QUEUE_KEY);
  } catch {}
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function fmtDist(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

function fmtEta(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function fmtDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m}m ${seconds % 60}s`;
}

function decodePolyline(encoded: string): { latitude: number; longitude: number }[] {
  const points: { latitude: number; longitude: number }[] = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b: number, shift = 0, result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    points.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
  }
  return points;
}

export default function MapScreen() {
  const mapRef = useRef<MapView>(null);
  const locationSubscription = useRef<Location.LocationSubscription | null>(null);
  const isOnlineRef = useRef(true);
  const prevNavLocRef = useRef<{ lat: number; lng: number } | null>(null);
  const navStartTimeRef = useRef<Date | null>(null);
  const destinationRef = useRef<{ lat: number; lng: number; name: string } | null>(null);
  const navActiveRef = useRef(false);
  const arrivedRef = useRef(false);
  const routeCoordsRef = useRef<{ latitude: number; longitude: number }[]>([]);
  const rerouteCooldownRef = useRef(false);

  const [currentLocation, setCurrentLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [destination, setDestination] = useState<{ lat: number; lng: number; name: string } | null>(null);
  const [searchText, setSearchText] = useState('');
  const [searchResults, setSearchResults] = useState<{ place_id: string; description: string; lat?: number; lon?: number }[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [routeCoords, setRouteCoords] = useState<{ latitude: number; longitude: number }[]>([]);
  const [distanceKm, setDistanceKm] = useState<number | null>(null);
  const [etaMinutes, setEtaMinutes] = useState<number | null>(null);
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [permissionLoading, setPermissionLoading] = useState(true);

  // Navigation
  const [navActive, setNavActive] = useState(false);
  const [distanceCovered, setDistanceCovered] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [arrived, setArrived] = useState(false);
  const [completionInfo, setCompletionInfo] = useState<{ distance: number; duration: number } | null>(null);
  const [isRerouting, setIsRerouting] = useState(false);

  // Keep refs in sync so location callback doesn't close over stale state
  useEffect(() => { destinationRef.current = destination; }, [destination]);
  useEffect(() => { navActiveRef.current = navActive; }, [navActive]);
  useEffect(() => { arrivedRef.current = arrived; }, [arrived]);
  useEffect(() => { routeCoordsRef.current = routeCoords; }, [routeCoords]);

  // Elapsed timer
  useEffect(() => {
    if (!navActive) return;
    const t = setInterval(() => setElapsedSeconds(s => s + 1), 1000);
    return () => clearInterval(t);
  }, [navActive]);

  useEffect(() => {
    requestLocationPermission();
    const unsubNet = NetInfo.addEventListener(state => {
      const online = state.isConnected ?? true;
      if (online && !isOnlineRef.current) flushGPSQueue();
      isOnlineRef.current = online;
    });
    return () => { locationSubscription.current?.remove(); unsubNet(); };
  }, []);

  async function requestLocationPermission() {
    setPermissionLoading(true);
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') { setPermissionGranted(false); setPermissionLoading(false); return; }
    setPermissionGranted(true);
    setPermissionLoading(false);
    startLocationTracking();
  }

  async function startLocationTracking() {
    locationSubscription.current?.remove();
    const sub = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 3000, distanceInterval: 5 },
      (loc) => {
        const newLoc = { lat: loc.coords.latitude, lng: loc.coords.longitude };
        setCurrentLocation(newLoc);

        // GPS backend ping
        const ping: GPSPingItem = {
          latitude: loc.coords.latitude, longitude: loc.coords.longitude,
          accuracy: loc.coords.accuracy, timestamp: new Date(loc.timestamp).toISOString(),
        };
        if (isOnlineRef.current) {
          apiFetch('/api/gps/batch', { method: 'POST', body: JSON.stringify({ pings: [ping] }) })
            .catch(() => queueGPSPing(ping));
        } else {
          queueGPSPing(ping);
        }

        if (!navActiveRef.current || arrivedRef.current || !destinationRef.current) return;

        // Accumulate covered distance
        if (prevNavLocRef.current) {
          const delta = haversineKm(prevNavLocRef.current.lat, prevNavLocRef.current.lng, newLoc.lat, newLoc.lng);
          setDistanceCovered(prev => prev + delta);
        }
        prevNavLocRef.current = newLoc;

        // Off-route detection: find nearest point on current route
        const route = routeCoordsRef.current;
        if (route.length > 1 && !rerouteCooldownRef.current) {
          let minDist = Infinity;
          for (const pt of route) {
            const d = haversineKm(newLoc.lat, newLoc.lng, pt.latitude, pt.longitude);
            if (d < minDist) minDist = d;
          }
          if (minDist > 0.2) {
            // More than 200m off-route — recalculate
            rerouteCooldownRef.current = true;
            setIsRerouting(true);
            const dest = destinationRef.current!;
            fetchRoute(newLoc, dest).finally(() => {
              setIsRerouting(false);
              // Allow reroute again after 60s
              setTimeout(() => { rerouteCooldownRef.current = false; }, 60000);
            });
          }
        }

        // Update remaining
        const dest = destinationRef.current;
        const remaining = haversineKm(newLoc.lat, newLoc.lng, dest.lat, dest.lng);
        setDistanceKm(remaining);
        setEtaMinutes(Math.max(1, Math.ceil((remaining / 30) * 60)));

        // Arrival check
        if (remaining < ARRIVAL_THRESHOLD_KM) {
          const duration = navStartTimeRef.current
            ? Math.floor((Date.now() - navStartTimeRef.current.getTime()) / 1000)
            : 0;
          setDistanceCovered(prev => { setCompletionInfo({ distance: prev, duration }); return prev; });
          navActiveRef.current = false;
          arrivedRef.current = true;
          setNavActive(false);
          setArrived(true);
          return;
        }

        // Follow user
        mapRef.current?.animateToRegion({
          latitude: newLoc.lat, longitude: newLoc.lng,
          latitudeDelta: 0.005, longitudeDelta: 0.005,
        }, 400);
      }
    );
    locationSubscription.current = sub;
  }

  async function searchLocation(text: string) {
    if (text.length < 2) { setSearchResults([]); return; }
    setIsSearching(true);
    try {
      // Backend proxy (Nominatim)
      const res = await apiFetch(`/api/places/autocomplete?input=${encodeURIComponent(text)}`);
      if (res?.ok) {
        const data = await res.json();
        if (data.predictions?.length) { setSearchResults(data.predictions.slice(0, 5)); return; }
      }
      // Fallback: Google Places
      const gRes = await fetch(
        `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(text)}&key=${GOOGLE_MAPS_API_KEY}&language=en&components=country:in`
      );
      const gData = await gRes.json();
      if (gData.predictions) setSearchResults(gData.predictions.slice(0, 5));
    } catch {}
    finally { setIsSearching(false); }
  }

  async function selectPlace(result: any) {
    Keyboard.dismiss();
    setSearchText(result.description);
    setSearchResults([]);
    resetNavigation(false);

    let lat: number, lng: number;
    if (result.lat !== undefined && result.lon !== undefined) {
      lat = parseFloat(String(result.lat));
      lng = parseFloat(String(result.lon));
    } else {
      try {
        const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${result.place_id}&fields=geometry&key=${GOOGLE_MAPS_API_KEY}`;
        const res = await fetch(url);
        const data = await res.json();
        const loc = data.result?.geometry?.location;
        if (!loc) return;
        lat = loc.lat; lng = loc.lng;
      } catch { return; }
    }

    const dest = { lat, lng, name: result.description };
    setDestination(dest);
    if (currentLocation) {
      const dist = haversineKm(currentLocation.lat, currentLocation.lng, lat, lng);
      setDistanceKm(dist);
      setEtaMinutes(Math.ceil((dist / 30) * 60));
      fetchRoute(currentLocation, dest);
    }
    mapRef.current?.fitToCoordinates(
      [
        { latitude: currentLocation?.lat ?? lat, longitude: currentLocation?.lng ?? lng },
        { latitude: lat, longitude: lng },
      ],
      { edgePadding: { top: 100, right: 50, bottom: 280, left: 50 }, animated: true }
    );
  }

  async function fetchRoute(origin: { lat: number; lng: number }, dest: { lat: number; lng: number }) {
    const straight = [
      { latitude: origin.lat, longitude: origin.lng },
      { latitude: dest.lat, longitude: dest.lng },
    ];
    try {
      // OSRM: free, no API key, follows real roads (coords are lng,lat order)
      const url = `https://router.project-osrm.org/route/v1/driving/${origin.lng},${origin.lat};${dest.lng},${dest.lat}?overview=full&geometries=polyline`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.code === 'Ok' && data.routes?.length) {
        setRouteCoords(decodePolyline(data.routes[0].geometry));
        setDistanceKm(data.routes[0].distance / 1000);
        setEtaMinutes(Math.ceil(data.routes[0].duration / 60));
      } else {
        setRouteCoords(straight);
      }
    } catch {
      setRouteCoords(straight);
    }
  }

  function startNavigation() {
    if (!destination || !currentLocation) return;
    prevNavLocRef.current = currentLocation;
    navStartTimeRef.current = new Date();
    setDistanceCovered(0);
    setElapsedSeconds(0);
    setArrived(false);
    setCompletionInfo(null);
    setNavActive(true);
    mapRef.current?.animateToRegion({
      latitude: currentLocation.lat, longitude: currentLocation.lng,
      latitudeDelta: 0.005, longitudeDelta: 0.005,
    }, 500);
  }

  function stopNavigation() {
    const duration = navStartTimeRef.current
      ? Math.floor((Date.now() - navStartTimeRef.current.getTime()) / 1000)
      : elapsedSeconds;
    setCompletionInfo({ distance: distanceCovered, duration });
    navActiveRef.current = false;
    setNavActive(false);
    setArrived(false);
  }

  function resetNavigation(clearDest = true) {
    navActiveRef.current = false;
    arrivedRef.current = false;
    setNavActive(false);
    setArrived(false);
    setCompletionInfo(null);
    setDistanceCovered(0);
    setElapsedSeconds(0);
    prevNavLocRef.current = null;
    navStartTimeRef.current = null;
    if (clearDest) {
      setDestination(null);
      setRouteCoords([]);
      setDistanceKm(null);
      setEtaMinutes(null);
    }
  }

  if (permissionLoading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#faf9f6' }}>
        <ActivityIndicator size="large" color="#1a1c1a" />
        <Text style={{ marginTop: 12, color: '#747878', fontSize: 13, fontFamily: 'DM-Sans' }}>Getting your location...</Text>
      </View>
    );
  }

  if (!permissionGranted) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#faf9f6', padding: 32 }}>
        <Ionicons name="location-outline" size={48} color="#695d4a" />
        <Text style={{ fontSize: 18, fontWeight: '700', color: '#1a1c1a', marginTop: 16, textAlign: 'center', fontFamily: 'DM-Sans' }}>
          Location Permission Required
        </Text>
        <Text style={{ fontSize: 13, color: '#747878', marginTop: 8, textAlign: 'center', lineHeight: 20, fontFamily: 'DM-Sans' }}>
          FieldPulse needs location access to track your route and verify attendance.
        </Text>
        <TouchableOpacity
          onPress={requestLocationPermission}
          style={{ marginTop: 24, backgroundColor: '#1a1c1a', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 4 }}
        >
          <Text style={{ color: '#fff', fontWeight: '500', textTransform: 'uppercase', letterSpacing: 1, fontSize: 12, fontFamily: 'DM-Sans' }}>
            Grant Permission
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <MapView
        ref={mapRef}
        provider={PROVIDER_GOOGLE}
        style={{ flex: 1 }}
        initialRegion={{
          latitude: currentLocation?.lat ?? 17.385,
          longitude: currentLocation?.lng ?? 78.4867,
          latitudeDelta: 0.05,
          longitudeDelta: 0.05,
        }}
        showsUserLocation={true}
        showsMyLocationButton={false}
        showsCompass={navActive}
        rotateEnabled={navActive}
      >
        {currentLocation && !navActive && (
          <Marker coordinate={{ latitude: currentLocation.lat, longitude: currentLocation.lng }} anchor={{ x: 0.5, y: 0.5 }}>
            <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: '#1a1c1a', borderWidth: 2, borderColor: '#fff' }} />
          </Marker>
        )}
        {destination && (
          <Marker coordinate={{ latitude: destination.lat, longitude: destination.lng }} title={destination.name}>
            <View style={{ alignItems: 'center' }}>
              <View style={{
                width: 36, height: 36, borderRadius: 18,
                backgroundColor: arrived ? '#166534' : '#695d4a',
                justifyContent: 'center', alignItems: 'center',
                borderWidth: 2, borderColor: '#fff',
              }}>
                <Ionicons name={arrived ? 'checkmark' : 'location'} size={18} color="#fff" />
              </View>
            </View>
          </Marker>
        )}
        {routeCoords.length > 0 && (
          <>
            {/* Thick white outline for contrast against any map tile */}
            <Polyline
              coordinates={routeCoords}
              strokeColor="#ffffff"
              strokeWidth={navActive ? 9 : 6}
            />
            {/* Bright orange line on top — clearly visible over blue roads */}
            <Polyline
              coordinates={routeCoords}
              strokeColor="#FF6D00"
              strokeWidth={navActive ? 5 : 3}
            />
          </>
        )}
      </MapView>

      {/* ── Active nav: top HUD ── */}
      {navActive && (
        <View style={{
          position: 'absolute', top: 0, left: 0, right: 0,
          backgroundColor: '#1a1c1a',
          paddingTop: Platform.OS === 'android' ? 36 : 52,
          paddingBottom: 16, paddingHorizontal: 20,
          elevation: 100, zIndex: 100,
        }}>
          {isRerouting && (
            <View style={{ backgroundColor: '#f59e0b', borderRadius: 6, paddingHorizontal: 12, paddingVertical: 4, alignSelf: 'flex-start', marginBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <ActivityIndicator size="small" color="#fff" />
              <Text style={{ color: '#fff', fontSize: 11, fontWeight: '700', fontFamily: 'DM-Sans' }}>Re-routing...</Text>
            </View>
          )}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View>
              <Text style={{ fontSize: 9, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: 1.5, fontFamily: 'DM-Sans' }}>
                Remaining
              </Text>
              <Text style={{ fontSize: 34, fontWeight: '800', color: '#fff', fontFamily: 'DM-Sans', lineHeight: 38 }}>
                {distanceKm !== null ? fmtDist(distanceKm) : '--'}
              </Text>
              <Text style={{ fontSize: 12, color: '#f2e0c8', fontFamily: 'DM-Sans', marginTop: 2 }}>
                ETA: {etaMinutes !== null ? fmtEta(etaMinutes) : '--'}
              </Text>
            </View>
            <TouchableOpacity
              onPress={stopNavigation}
              style={{ backgroundColor: '#ba1a1a', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 6 }}
            >
              <Text style={{ color: '#fff', fontSize: 11, fontWeight: '700', fontFamily: 'DM-Sans', textTransform: 'uppercase', letterSpacing: 0.8 }}>
                End
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* ── Active nav: bottom strip ── */}
      {navActive && (
        <View style={{
          position: 'absolute', bottom: 0, left: 0, right: 0,
          backgroundColor: '#fff', borderTopWidth: 0.5, borderTopColor: '#e3e2e0',
          padding: 14, paddingBottom: 28, flexDirection: 'row', gap: 10,
          elevation: 100, zIndex: 100,
        }}>
          <View style={{ flex: 1, backgroundColor: '#f5f4f1', borderRadius: 8, padding: 12, alignItems: 'center' }}>
            <Ionicons name="navigate-outline" size={16} color="#1a6ef2" />
            <Text style={{ fontSize: 15, fontWeight: '700', color: '#1a1c1a', fontFamily: 'DM-Sans', marginTop: 3 }}>
              {fmtDist(distanceCovered)}
            </Text>
            <Text style={{ fontSize: 9, color: '#747878', textTransform: 'uppercase', letterSpacing: 0.8, fontFamily: 'DM-Sans', marginTop: 1 }}>
              Covered
            </Text>
          </View>
          <View style={{ flex: 1, backgroundColor: '#f5f4f1', borderRadius: 8, padding: 12, alignItems: 'center' }}>
            <Ionicons name="time-outline" size={16} color="#695d4a" />
            <Text style={{ fontSize: 15, fontWeight: '700', color: '#1a1c1a', fontFamily: 'DM-Sans', marginTop: 3 }}>
              {fmtDuration(elapsedSeconds)}
            </Text>
            <Text style={{ fontSize: 9, color: '#747878', textTransform: 'uppercase', letterSpacing: 0.8, fontFamily: 'DM-Sans', marginTop: 1 }}>
              Elapsed
            </Text>
          </View>
          <View style={{ flex: 1, backgroundColor: '#f5f4f1', borderRadius: 8, padding: 12, alignItems: 'center' }}>
            <Ionicons name="location-outline" size={16} color="#166534" />
            <Text style={{ fontSize: 12, fontWeight: '700', color: '#1a1c1a', fontFamily: 'DM-Sans', marginTop: 3, textAlign: 'center' }} numberOfLines={2}>
              {destination?.name?.split(',')[0] ?? '--'}
            </Text>
            <Text style={{ fontSize: 9, color: '#747878', textTransform: 'uppercase', letterSpacing: 0.8, fontFamily: 'DM-Sans', marginTop: 1 }}>
              Heading to
            </Text>
          </View>
        </View>
      )}

      {/* ── Trip completion card ── */}
      {completionInfo && (
        <View style={{
          position: 'absolute', bottom: 0, left: 0, right: 0,
          backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20,
          borderTopWidth: 0.5, borderTopColor: '#e3e2e0',
          padding: 24, paddingBottom: 36,
          elevation: 100, zIndex: 100,
        }}>
          <View style={{ alignItems: 'center', marginBottom: 20 }}>
            <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: '#dcfce7', justifyContent: 'center', alignItems: 'center', marginBottom: 10 }}>
              <Ionicons name="checkmark-circle" size={32} color="#166534" />
            </View>
            <Text style={{ fontSize: 20, fontWeight: '700', color: '#1a1c1a', fontFamily: 'DM-Sans' }}>
              {arrived ? "You've Arrived!" : 'Trip Summary'}
            </Text>
            <Text style={{ fontSize: 12, color: '#747878', fontFamily: 'DM-Sans', marginTop: 4, textAlign: 'center' }} numberOfLines={1}>
              {destination?.name}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 12, marginBottom: 20 }}>
            <View style={{ flex: 1, backgroundColor: '#f5f4f1', borderRadius: 10, padding: 14, alignItems: 'center' }}>
              <Ionicons name="navigate" size={20} color="#1a6ef2" />
              <Text style={{ fontSize: 22, fontWeight: '700', color: '#1a1c1a', fontFamily: 'DM-Sans', marginTop: 6 }}>
                {fmtDist(completionInfo.distance)}
              </Text>
              <Text style={{ fontSize: 9, color: '#747878', textTransform: 'uppercase', letterSpacing: 0.8, fontFamily: 'DM-Sans', marginTop: 2 }}>
                Total Distance
              </Text>
            </View>
            <View style={{ flex: 1, backgroundColor: '#f5f4f1', borderRadius: 10, padding: 14, alignItems: 'center' }}>
              <Ionicons name="time" size={20} color="#695d4a" />
              <Text style={{ fontSize: 22, fontWeight: '700', color: '#1a1c1a', fontFamily: 'DM-Sans', marginTop: 6 }}>
                {fmtDuration(completionInfo.duration)}
              </Text>
              <Text style={{ fontSize: 9, color: '#747878', textTransform: 'uppercase', letterSpacing: 0.8, fontFamily: 'DM-Sans', marginTop: 2 }}>
                Time Taken
              </Text>
            </View>
          </View>
          <TouchableOpacity
            onPress={() => resetNavigation(true)}
            style={{ backgroundColor: '#1a1c1a', borderRadius: 6, paddingVertical: 14, alignItems: 'center' }}
          >
            <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 1, fontFamily: 'DM-Sans' }}>
              Done
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Search bar (hidden during nav) ── */}
      {!navActive && !completionInfo && (
        <View style={{
          position: 'absolute', top: 12, left: 12, right: 12,
          backgroundColor: '#fff', borderRadius: 8,
          borderWidth: 0.5, borderColor: '#c4c7c7',
          shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 10,
          elevation: 100, zIndex: 100,
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10 }}>
            <Ionicons name="search" size={18} color="#747878" />
            <TextInput
              style={{ flex: 1, marginLeft: 8, fontSize: 13, color: '#1a1c1a', fontFamily: 'DM-Sans' }}
              placeholder="Search destination..."
              placeholderTextColor="#c4c7c7"
              value={searchText}
              onChangeText={(text) => { setSearchText(text); searchLocation(text); }}
              returnKeyType="search"
            />
            {isSearching && <ActivityIndicator size="small" color="#695d4a" />}
            {searchText.length > 0 && !isSearching && (
              <TouchableOpacity onPress={() => { setSearchText(''); setSearchResults([]); resetNavigation(true); }}>
                <Ionicons name="close-circle" size={18} color="#c4c7c7" />
              </TouchableOpacity>
            )}
          </View>
          {searchResults.length > 0 && (
            <View style={{ borderTopWidth: 0.5, borderTopColor: '#efeeeb' }}>
              {searchResults.map((result, idx) => (
                <TouchableOpacity
                  key={String(result.place_id)}
                  style={{
                    paddingHorizontal: 14, paddingVertical: 11,
                    borderBottomWidth: idx < searchResults.length - 1 ? 0.5 : 0,
                    borderBottomColor: '#efeeeb',
                    flexDirection: 'row', alignItems: 'center', gap: 10,
                  }}
                  onPress={() => selectPlace(result)}
                >
                  <Ionicons name="location-outline" size={15} color="#695d4a" />
                  <Text style={{ flex: 1, fontSize: 12, color: '#1a1c1a', fontFamily: 'DM-Sans' }} numberOfLines={2}>
                    {result.description}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>
      )}

      {/* ── My location button ── */}
      {!navActive && !completionInfo && (
        <TouchableOpacity
          style={{
            position: 'absolute', right: 12,
            bottom: destination ? 240 : 100,
            width: 40, height: 40, borderRadius: 20,
            backgroundColor: '#fff', justifyContent: 'center', alignItems: 'center',
            borderWidth: 0.5, borderColor: '#c4c7c7', elevation: 100, zIndex: 100,
          }}
          onPress={() => {
            if (currentLocation && mapRef.current) {
              mapRef.current.animateToRegion({
                latitude: currentLocation.lat, longitude: currentLocation.lng,
                latitudeDelta: 0.01, longitudeDelta: 0.01,
              }, 500);
            }
          }}
        >
          <Ionicons name="locate" size={20} color="#1a1c1a" />
        </TouchableOpacity>
      )}

      {/* ── Destination sheet (before nav starts) ── */}
      {destination && !navActive && !completionInfo && (
        <View style={{
          position: 'absolute', bottom: 0, left: 0, right: 0,
          backgroundColor: '#faf9f6', borderTopLeftRadius: 16, borderTopRightRadius: 16,
          borderTopWidth: 0.5, borderTopColor: '#e3e2e0',
          padding: 20, paddingBottom: 32,
          shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 16, elevation: 100, zIndex: 100,
        }}>
          <View style={{ width: 36, height: 3, backgroundColor: '#c4c7c7', borderRadius: 2, alignSelf: 'center', marginBottom: 14 }} />
          <Text style={{ fontSize: 9, color: '#695d4a', textTransform: 'uppercase', letterSpacing: 1.5, fontFamily: 'DM-Sans', fontWeight: '500', marginBottom: 4 }}>
            Destination
          </Text>
          <Text style={{ fontSize: 15, fontWeight: '700', color: '#1a1c1a', marginBottom: 12, fontFamily: 'DM-Sans' }} numberOfLines={2}>
            {destination.name}
          </Text>
          <View style={{ flexDirection: 'row', gap: 12, marginBottom: 16 }}>
            {distanceKm !== null && (
              <View style={{ flex: 1, backgroundColor: '#fff', borderWidth: 0.5, borderColor: '#e3e2e0', borderRadius: 8, padding: 12 }}>
                <Text style={{ fontSize: 18, fontWeight: '700', color: '#1a1c1a', fontFamily: 'DM-Sans' }}>{fmtDist(distanceKm)}</Text>
                <Text style={{ fontSize: 10, color: '#747878', textTransform: 'uppercase', letterSpacing: 0.8, fontFamily: 'DM-Sans' }}>Distance</Text>
              </View>
            )}
            {etaMinutes !== null && (
              <View style={{ flex: 1, backgroundColor: '#fff', borderWidth: 0.5, borderColor: '#e3e2e0', borderRadius: 8, padding: 12 }}>
                <Text style={{ fontSize: 18, fontWeight: '700', color: '#1a1c1a', fontFamily: 'DM-Sans' }}>{fmtEta(etaMinutes)}</Text>
                <Text style={{ fontSize: 10, color: '#747878', textTransform: 'uppercase', letterSpacing: 0.8, fontFamily: 'DM-Sans' }}>ETA</Text>
              </View>
            )}
          </View>
          <TouchableOpacity
            style={{
              backgroundColor: '#1a6ef2', paddingVertical: 14, borderRadius: 4,
              flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
            }}
            onPress={startNavigation}
          >
            <Ionicons name="navigate" size={16} color="#fff" />
            <Text style={{ color: '#fff', fontWeight: '600', fontSize: 13, textTransform: 'uppercase', letterSpacing: 1, fontFamily: 'DM-Sans' }}>
              Start Navigation
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}
