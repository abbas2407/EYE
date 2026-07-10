import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  ActivityIndicator, Platform, Keyboard, Linking
} from 'react-native';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE, Region } from 'react-native-maps';
import * as Location from 'expo-location';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { apiFetch } from '../api/client';

const GOOGLE_MAPS_API_KEY = 'AIzaSyAJHF-B2ulEDrxStgKH4NS7szhFdjErnos';
const GPS_QUEUE_KEY = 'gps_offline_queue';

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
    if (queue.length === 0) return;
    const res = await apiFetch('/api/gps/batch', {
      method: 'POST',
      body: JSON.stringify({ pings: queue }),
    });
    if (res.ok) await AsyncStorage.removeItem(GPS_QUEUE_KEY);
  } catch {}
}

export default function MapScreen() {
  const mapRef = useRef<MapView>(null);
  const locationSubscription = useRef<Location.LocationSubscription | null>(null);
  const isOnlineRef = useRef(true);

  const [currentLocation, setCurrentLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [destination, setDestination] = useState<{ lat: number; lng: number; name: string } | null>(null);
  const [searchText, setSearchText] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [routeCoords, setRouteCoords] = useState<{ latitude: number; longitude: number }[]>([]);
  const [distanceKm, setDistanceKm] = useState<number | null>(null);
  const [etaMinutes, setEtaMinutes] = useState<number | null>(null);
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [permissionLoading, setPermissionLoading] = useState(true);

  useEffect(() => {
    requestLocationPermission();
    const unsubNet = NetInfo.addEventListener(state => {
      const online = state.isConnected ?? true;
      if (online && !isOnlineRef.current) {
        flushGPSQueue();
      }
      isOnlineRef.current = online;
    });
    return () => {
      locationSubscription.current?.remove();
      unsubNet();
    };
  }, []);

  async function requestLocationPermission() {
    setPermissionLoading(true);
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      setPermissionGranted(false);
      setPermissionLoading(false);
      return;
    }
    setPermissionGranted(true);
    setPermissionLoading(false);
    startLocationTracking();
  }

  async function startLocationTracking() {
    locationSubscription.current?.remove();
    const sub = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: 5000,
        distanceInterval: 10,
      },
      (loc) => {
        const newLoc = { lat: loc.coords.latitude, lng: loc.coords.longitude };
        setCurrentLocation(newLoc);

        const ping: GPSPingItem = {
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
          accuracy: loc.coords.accuracy,
          timestamp: new Date(loc.timestamp).toISOString(),
        };
        if (isOnlineRef.current) {
          apiFetch('/api/gps/batch', { method: 'POST', body: JSON.stringify({ pings: [ping] }) }).catch(() => {
            queueGPSPing(ping);
          });
        } else {
          queueGPSPing(ping);
        }

        if (destination) {
          const dist = haversineKm(newLoc.lat, newLoc.lng, destination.lat, destination.lng);
          setDistanceKm(dist);
          setEtaMinutes(Math.ceil((dist / 30) * 60));
        }

        setDestination(prev => {
          if (!prev && mapRef.current) {
            mapRef.current.animateToRegion({
              latitude: loc.coords.latitude,
              longitude: loc.coords.longitude,
              latitudeDelta: 0.01,
              longitudeDelta: 0.01,
            }, 500);
          }
          return prev;
        });
      }
    );
    locationSubscription.current = sub;
  }

  function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  async function searchLocation(text: string) {
    if (text.length < 2) {
      setSearchResults([]);
      return;
    }
    setIsSearching(true);
    try {
      const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(text)}&key=${GOOGLE_MAPS_API_KEY}&language=en&components=country:in`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.predictions) {
        setSearchResults(data.predictions.slice(0, 5));
      }
    } catch (err) {
      console.warn('Search error:', err);
    } finally {
      setIsSearching(false);
    }
  }

  async function selectPlace(placeId: string, placeName: string) {
    Keyboard.dismiss();
    setSearchText(placeName);
    setSearchResults([]);
    try {
      const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=geometry&key=${GOOGLE_MAPS_API_KEY}`;
      const res = await fetch(url);
      const data = await res.json();
      const loc = data.result?.geometry?.location;
      if (!loc) return;

      const dest = { lat: loc.lat, lng: loc.lng, name: placeName };
      setDestination(dest);

      if (currentLocation) {
        const dist = haversineKm(currentLocation.lat, currentLocation.lng, dest.lat, dest.lng);
        setDistanceKm(dist);
        setEtaMinutes(Math.ceil((dist / 30) * 60));
        fetchRoute(currentLocation, dest);
      }

      if (mapRef.current && currentLocation) {
        mapRef.current.fitToCoordinates(
          [
            { latitude: currentLocation.lat, longitude: currentLocation.lng },
            { latitude: dest.lat, longitude: dest.lng },
          ],
          { edgePadding: { top: 100, right: 50, bottom: 200, left: 50 }, animated: true }
        );
      }
    } catch (err) {
      console.warn('Place details error:', err);
    }
  }

  async function fetchRoute(origin: { lat: number; lng: number }, dest: { lat: number; lng: number }) {
    try {
      const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin.lat},${origin.lng}&destination=${dest.lat},${dest.lng}&key=${GOOGLE_MAPS_API_KEY}&mode=driving`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.routes?.length > 0) {
        const points = decodePolyline(data.routes[0].overview_polyline.points);
        setRouteCoords(points);
        const leg = data.routes[0].legs[0];
        if (leg) {
          setDistanceKm(leg.distance.value / 1000);
          setEtaMinutes(Math.ceil(leg.duration.value / 60));
        }
      }
    } catch {
      if (currentLocation) {
        setRouteCoords([
          { latitude: currentLocation.lat, longitude: currentLocation.lng },
          { latitude: dest.lat, longitude: dest.lng },
        ]);
      }
    }
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

  if (permissionLoading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#faf9f6' }}>
        <ActivityIndicator size="large" color="#1a1c1a" />
        <Text style={{ marginTop: 12, color: '#747878', fontSize: 13, fontFamily: 'DM-Sans' }}>
          Getting your location...
        </Text>
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
        showsCompass={false}
        customMapStyle={GREYSCALE_MAP_STYLE}
      >
        {currentLocation && (
          <Marker
            coordinate={{ latitude: currentLocation.lat, longitude: currentLocation.lng }}
            anchor={{ x: 0.5, y: 0.5 }}
          >
            <View style={{
              width: 16, height: 16, borderRadius: 8,
              backgroundColor: '#1a1c1a', borderWidth: 2, borderColor: '#fff',
            }} />
          </Marker>
        )}

        {destination && (
          <Marker
            coordinate={{ latitude: destination.lat, longitude: destination.lng }}
            title={destination.name}
          >
            <View style={{ alignItems: 'center' }}>
              <View style={{
                width: 36, height: 36, borderRadius: 18,
                backgroundColor: '#695d4a', justifyContent: 'center', alignItems: 'center',
                borderWidth: 2, borderColor: '#fff',
              }}>
                <Ionicons name="location" size={18} color="#fff" />
              </View>
            </View>
          </Marker>
        )}

        {routeCoords.length > 0 && (
          <Polyline
            coordinates={routeCoords}
            strokeColor="#1a1c1a"
            strokeWidth={3}
            lineDashPattern={[1]}
          />
        )}
      </MapView>

      {/* Search bar overlay */}
      <View style={{
        position: 'absolute', top: 12, left: 12, right: 12,
        backgroundColor: '#fff', borderRadius: 8,
        borderWidth: 0.5, borderColor: '#c4c7c7',
        shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 8,
        elevation: 4,
      }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10 }}>
          <Ionicons name="search" size={18} color="#747878" />
          <TextInput
            style={{ flex: 1, marginLeft: 8, fontSize: 13, color: '#1a1c1a', fontFamily: 'DM-Sans' }}
            placeholder="Search destination..."
            placeholderTextColor="#c4c7c7"
            value={searchText}
            onChangeText={(text) => {
              setSearchText(text);
              searchLocation(text);
            }}
            returnKeyType="search"
          />
          {isSearching && <ActivityIndicator size="small" color="#695d4a" />}
          {searchText.length > 0 && !isSearching && (
            <TouchableOpacity onPress={() => {
              setSearchText('');
              setSearchResults([]);
              setDestination(null);
              setRouteCoords([]);
              setDistanceKm(null);
              setEtaMinutes(null);
            }}>
              <Ionicons name="close-circle" size={18} color="#c4c7c7" />
            </TouchableOpacity>
          )}
        </View>

        {searchResults.length > 0 && (
          <View style={{ borderTopWidth: 0.5, borderTopColor: '#efeeeb' }}>
            {searchResults.map((result: any, idx: number) => (
              <TouchableOpacity
                key={result.place_id}
                style={{
                  paddingHorizontal: 14, paddingVertical: 11,
                  borderBottomWidth: idx < searchResults.length - 1 ? 0.5 : 0,
                  borderBottomColor: '#efeeeb',
                  flexDirection: 'row', alignItems: 'center', gap: 10,
                }}
                onPress={() => selectPlace(result.place_id, result.description)}
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

      {/* My location button */}
      <TouchableOpacity
        style={{
          position: 'absolute', right: 12, bottom: destination ? 220 : 100,
          width: 40, height: 40, borderRadius: 20,
          backgroundColor: '#fff', justifyContent: 'center', alignItems: 'center',
          borderWidth: 0.5, borderColor: '#c4c7c7', elevation: 3,
        }}
        onPress={() => {
          if (currentLocation && mapRef.current) {
            mapRef.current.animateToRegion({
              latitude: currentLocation.lat,
              longitude: currentLocation.lng,
              latitudeDelta: 0.01,
              longitudeDelta: 0.01,
            }, 500);
          }
        }}
      >
        <Ionicons name="locate" size={20} color="#1a1c1a" />
      </TouchableOpacity>

      {/* Destination bottom sheet */}
      {destination && (
        <View style={{
          position: 'absolute', bottom: 0, left: 0, right: 0,
          backgroundColor: '#faf9f6', borderTopLeftRadius: 16, borderTopRightRadius: 16,
          borderTopWidth: 0.5, borderTopColor: '#e3e2e0',
          padding: 20, paddingBottom: 32,
          shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 16, elevation: 8,
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
                <Text style={{ fontSize: 18, fontWeight: '700', color: '#1a1c1a', fontFamily: 'DM-Sans' }}>
                  {distanceKm < 1 ? `${Math.round(distanceKm * 1000)}m` : `${distanceKm.toFixed(1)}km`}
                </Text>
                <Text style={{ fontSize: 10, color: '#747878', textTransform: 'uppercase', letterSpacing: 0.8, fontFamily: 'DM-Sans' }}>
                  Distance
                </Text>
              </View>
            )}
            {etaMinutes !== null && (
              <View style={{ flex: 1, backgroundColor: '#fff', borderWidth: 0.5, borderColor: '#e3e2e0', borderRadius: 8, padding: 12 }}>
                <Text style={{ fontSize: 18, fontWeight: '700', color: '#1a1c1a', fontFamily: 'DM-Sans' }}>
                  {etaMinutes < 60 ? `${etaMinutes} min` : `${Math.floor(etaMinutes / 60)}h ${etaMinutes % 60}m`}
                </Text>
                <Text style={{ fontSize: 10, color: '#747878', textTransform: 'uppercase', letterSpacing: 0.8, fontFamily: 'DM-Sans' }}>
                  ETA
                </Text>
              </View>
            )}
          </View>

          <TouchableOpacity
            style={{
              backgroundColor: '#1a1c1a', paddingVertical: 14, borderRadius: 4,
              flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
            }}
            onPress={() => {
              const url = `https://www.google.com/maps/dir/?api=1&destination=${destination.lat},${destination.lng}&travelmode=driving`;
              Linking.openURL(url);
            }}
          >
            <Ionicons name="navigate" size={16} color="#fff" />
            <Text style={{ color: '#fff', fontWeight: '500', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, fontFamily: 'DM-Sans' }}>
              Open Navigation
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const GREYSCALE_MAP_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#f5f5f5' }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#616161' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#f5f5f5' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#ffffff' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#e9e8e5' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#dadada' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#e3e2e0' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
];
