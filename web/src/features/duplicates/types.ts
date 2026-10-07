import type { BulkDeleteResult, Photo } from '../../app/api';

export type DuplicateKind = 'exact' | 'perceptual' | 'ai';
export interface DuplicateItem extends Photo {
  review: { id: string; revision: string; checksum: string; motion: string };
  folder_path: string;
  has_favorites: boolean;
  has_shares: boolean;
  has_face_annotations: boolean;
  sharpness: number;
  exposure: number;
}
export interface DuplicateGroup {
  id: string; kind: DuplicateKind; version: string; owner_id: string; owner_name?: string;
  score: number; reason: 'identical' | 'visual_hash' | 'visual_hash_ai' | 'local_features' | 'burst';
  items: DuplicateItem[]; recommended_id: string;
}
export interface DuplicatePage { items: DuplicateGroup[]; next_cursor: string; skipped: number }
export interface DuplicateJob {
  id: string; mode: 'perceptual' | 'ai'; status: 'running' | 'paused' | 'completed' | 'cancelled' | 'failed';
  total: number; processed: number; failed: number; error: string;
}
export interface DuplicateCleanup {
  group_id: string; version: string; kind: DuplicateKind; keep_id: string; remove_ids: string[]; confirm: boolean;
}
export interface DuplicatesAPI {
  config(): Promise<{ ai_enabled: boolean }>;
  groups(kind: DuplicateKind, cursor?: string, signal?: AbortSignal): Promise<DuplicatePage>;
  jobs(): Promise<{ items: DuplicateJob[] }>;
  start(mode: 'perceptual' | 'ai'): Promise<DuplicateJob>;
  control(id: string, action: 'pause' | 'resume' | 'cancel'): Promise<DuplicateJob>;
  cleanup(input: DuplicateCleanup): Promise<BulkDeleteResult>;
}
