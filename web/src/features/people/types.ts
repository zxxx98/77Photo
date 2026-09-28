export interface FaceJob {
  id: string; mode: string; status: string; error: string; created_at: string; updated_at: string;
  counts: { total: number; pending: number; succeeded: number; failed: number; skipped: number; cancelled: number };
}
export interface FailedFaceItem { photo_id: string; filename: string; error: string }
export interface Person { id: string; owner_id: string; name: string; revision: number; photo_count: number; cover_face_id: string }
export interface SimilarPerson { person: Person; score: number }
export interface Face { owner_id: string; id: string; photo_id: string; person_id: string; filename: string; revision: number; ignored: boolean; bbox: [number, number, number, number] }
export interface FaceConfig { enabled: boolean; configured: boolean; automatic_matching: boolean; match_threshold: number; match_margin: number; concurrency: number }
export interface FacePage<T> { items: T[]; next_cursor: string }
export interface FacesAPI {
  config(): Promise<FaceConfig>;
  test(): Promise<{ device: string; pipeline_id: string }>;
  jobs(): Promise<{ items: FaceJob[] }>;
  failedItems(jobId: string, cursor?: string): Promise<FacePage<FailedFaceItem>>;
  start(mode: 'incremental' | 'retry_failed' | 'regroup' | 'full', key: string): Promise<FaceJob>;
  control(id: string, action: 'pause' | 'resume' | 'cancel'): Promise<FaceJob>;
  people(cursor?: string): Promise<FacePage<Person>>;
  similarPeople(person: string): Promise<{ items: SimilarPerson[] }>;
  listFaces(person: string, cursor?: string): Promise<FacePage<Face>>;
  rename(person: Person, name: string): Promise<unknown>;
  merge(target: Person, source: Person): Promise<unknown>;
  assign(face: Face, personId: string, ignored: boolean): Promise<unknown>;
}
export const faceThumbnail = (id: string) => `/api/v1/admin/faces/${encodeURIComponent(id)}/thumbnail`;
