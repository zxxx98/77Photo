package com.photo77.upload.db

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

object UploadTaskState {
  const val QUEUED = "queued"
  const val UPLOADING = "uploading"
  const val PAUSED = "paused"
  const val SUCCEEDED = "succeeded"
  const val FAILED = "failed"
  const val CANCELED = "canceled"
}

@Entity(
  tableName = "upload_tasks",
  indices = [
    Index(value = ["server_id", "state", "next_retry_at_epoch_ms", "created_at_epoch_ms"]),
    Index(value = ["server_id", "batch_id"]),
    Index(value = ["lease_owner", "lease_until_epoch_ms"]),
  ],
)
data class UploadTaskEntity(
  @PrimaryKey val id: String,
  @ColumnInfo(name = "batch_id") val batchId: String,
  @ColumnInfo(name = "content_uri") val contentUri: String,
  @ColumnInfo(name = "display_name") val displayName: String,
  @ColumnInfo(name = "mime_type") val mimeType: String,
  @ColumnInfo(name = "size_bytes") val sizeBytes: Long?,
  @ColumnInfo(name = "server_id") val serverId: String,
  @ColumnInfo(name = "user_id") val userId: String?,
  @ColumnInfo(name = "device_id") val deviceId: String,
  @ColumnInfo(name = "session_id") val sessionId: String?,
  @ColumnInfo(name = "folder_id") val folderId: String,
  val state: String,
  @ColumnInfo(name = "sent_bytes") val sentBytes: Long,
  val attempts: Int,
  @ColumnInfo(name = "last_error_code") val lastErrorCode: String?,
  @ColumnInfo(name = "last_error_message") val lastErrorMessage: String?,
  @ColumnInfo(name = "created_at_epoch_ms") val createdAtEpochMs: Long,
  @ColumnInfo(name = "started_at_epoch_ms") val startedAtEpochMs: Long?,
  @ColumnInfo(name = "completed_at_epoch_ms") val completedAtEpochMs: Long?,
  @ColumnInfo(name = "next_retry_at_epoch_ms") val nextRetryAtEpochMs: Long?,
  @ColumnInfo(name = "lease_owner") val leaseOwner: String?,
  @ColumnInfo(name = "lease_until_epoch_ms") val leaseUntilEpochMs: Long?,
)
