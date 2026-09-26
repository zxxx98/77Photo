import { useEffect, useRef } from 'react';
import type { MapConfig } from '../../app/api';
import { createMiniMap, type MiniMap } from './leafletMap';

export default function LocationMiniMap({ config, latitude, longitude }: { config: MapConfig; latitude: number; longitude: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MiniMap | null>(null);
  const position = useRef({ latitude, longitude });
  position.current = { latitude, longitude };

  useEffect(() => {
    if (!containerRef.current) return;
    const map = createMiniMap(containerRef.current, config, position.current.latitude, position.current.longitude);
    mapRef.current = map;
    return () => {
      map.destroy();
      mapRef.current = null;
    };
  }, [config]);

  useEffect(() => {
    mapRef.current?.setPosition(latitude, longitude);
  }, [latitude, longitude]);

  return <div className="immersive-viewer__minimap" ref={containerRef} />;
}
