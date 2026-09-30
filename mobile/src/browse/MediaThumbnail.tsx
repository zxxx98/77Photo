import React, {useEffect, useState, useSyncExternalStore} from 'react';
import {Image, StyleSheet, Text, View} from 'react-native';
import type {BrowseApi} from './api';

export default function MediaThumbnail({api, id, face = false, size = 80}: {api: BrowseApi; id: string; face?: boolean; size?: number}) {
  const revision = useSyncExternalStore(api.subscribe, api.getRevision);
  const [source, setSource] = useState<{uri: string; headers: {Authorization: string}}>();
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {setAttempt(0); setFailed(false);}, [id, face, revision]);
  useEffect(() => {
    let active = true; setSource(undefined);
    const timer = setTimeout(() => {
      (face ? api.faceSource(id) : api.mediaSource(id, 'thumbnail')).then(value => {
        if (active) {setSource({...value, uri: value.uri + (value.uri.includes('?') ? '&' : '?') + `retry=${attempt}`});}
      }).catch(() => {if (active) {setFailed(true);}});
    }, attempt ? 1000 : 0);
    return () => {active = false; clearTimeout(timer);};
  }, [api, id, face, revision, attempt]);
  return <View style={[styles.frame, {width: size, height: size}]}>{source && !failed ? <Image source={source} style={styles.image} resizeMode="cover"
    onError={() => {if (attempt < 2) {setAttempt(value => value + 1);} else {setFailed(true);}}} /> : <Text style={styles.placeholder}>{failed ? '无预览' : ''}</Text>}</View>;
}
const styles = StyleSheet.create({frame: {backgroundColor: '#ECE9E5', borderRadius: 8, overflow: 'hidden', alignItems: 'center', justifyContent: 'center'}, image: {width: '100%', height: '100%'}, placeholder: {fontSize: 11, color: '#75808A'}});
