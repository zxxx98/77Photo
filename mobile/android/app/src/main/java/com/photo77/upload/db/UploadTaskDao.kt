package com.photo77.upload.db

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction

@Dao
abstract class UploadTaskDao {
  @Insert(onConflict = OnConflictStrategy.ABORT)
  abstract fun insert(task: UploadTaskEntity)

  @Insert(onConflict = OnConflictStrategy.ABORT)
  abstract fun insertAll(tasks: List<UploadTaskEntity>)

  @Query("SELECT * FROM upload_tasks WHERE server_id = :serverId ORDER BY created_at_epoch_ms ASC, id ASC")
  abstract fun findByServer(serverId: String): List<UploadTaskEntity>

  @Query("SELECT * FROM upload_tasks WHERE id IN (:ids)")
  abstract fun findByIds(ids: List<String>): List<UploadTaskEntity>

  @Query(
    """
    SELECT id FROM upload_tasks
    WHERE server_id = :serverId
      AND state = 'queued'
      AND (next_retry_at_epoch_ms IS NULL OR next_retry_at_epoch_ms <= :now)
      AND (lease_until_epoch_ms IS NULL OR lease_until_epoch_ms < :now OR lease_owner = :owner)
    ORDER BY created_at_epoch_ms ASC, id ASC
    LIMIT :limit
    """,
  )
  abstract fun selectQueuedIds(serverId: String, owner: String, limit: Int, now: Long): List<String>

  @Query(
    """
    UPDATE upload_tasks
    SET state = 'uploading', lease_owner = :owner, lease_until_epoch_ms = :leaseUntil,
        started_at_epoch_ms = COALESCE(started_at_epoch_ms, :now)
    WHERE id = :id
      AND state = 'queued'
      AND (lease_until_epoch_ms IS NULL OR lease_until_epoch_ms < :now OR lease_owner = :owner)
    """,
  )
  abstract fun claimQueued(id: String, owner: String, now: Long, leaseUntil: Long): Int

  @Transaction
  open fun acquireQueued(serverId: String, owner: String, limit: Int, now: Long, leaseUntil: Long): List<UploadTaskEntity> {
    if (limit <= 0) return emptyList()
    val ids = selectQueuedIds(serverId, owner, limit, now)
    val claimed = ids.filter { claimQueued(it, owner, now, leaseUntil) == 1 }
    if (claimed.isEmpty()) return emptyList()
    val byId = findByIds(claimed).associateBy { it.id }
    return claimed.mapNotNull { byId[it] }
  }

  @Query(
    """
    UPDATE upload_tasks
    SET state = 'queued', lease_owner = NULL, lease_until_epoch_ms = NULL
    WHERE state = 'uploading' AND lease_until_epoch_ms IS NOT NULL AND lease_until_epoch_ms < :now
    """,
  )
  abstract fun recoverExpiredLeases(now: Long): Int

  @Query(
    """
    UPDATE upload_tasks
    SET state = :nextState, last_error_code = :errorCode, last_error_message = :errorMessage,
        completed_at_epoch_ms = CASE WHEN :nextState IN ('succeeded', 'canceled') THEN :now ELSE completed_at_epoch_ms END,
        lease_owner = CASE WHEN :nextState IN ('succeeded', 'failed', 'paused', 'canceled') THEN NULL ELSE lease_owner END,
        lease_until_epoch_ms = CASE WHEN :nextState IN ('succeeded', 'failed', 'paused', 'canceled') THEN NULL ELSE lease_until_epoch_ms END
    WHERE id = :id AND state = :expectedState
    """,
  )
  abstract fun updateState(
    id: String,
    expectedState: String,
    nextState: String,
    now: Long,
    errorCode: String?,
    errorMessage: String?,
  ): Int

  @Query(
    "UPDATE upload_tasks SET state = 'paused', lease_owner = NULL, lease_until_epoch_ms = NULL WHERE server_id = :serverId AND state = 'uploading'",
  )
  abstract fun pauseUploading(serverId: String): Int

  @Query(
    "UPDATE upload_tasks SET state = 'paused' WHERE server_id = :serverId AND state = 'queued'",
  )
  abstract fun pauseQueued(serverId: String): Int

  @Query("UPDATE upload_tasks SET state = 'queued' WHERE server_id = :serverId AND state = 'paused'")
  abstract fun resumePaused(serverId: String): Int

  @Query(
    "UPDATE upload_tasks SET state = 'queued', next_retry_at_epoch_ms = NULL, last_error_code = NULL, last_error_message = NULL WHERE server_id = :serverId AND state = 'failed'",
  )
  abstract fun retryFailed(serverId: String): Int

  @Query(
    "UPDATE upload_tasks SET state = 'canceled', completed_at_epoch_ms = :now, lease_owner = NULL, lease_until_epoch_ms = NULL WHERE id IN (:ids) AND state IN ('queued', 'paused', 'failed')",
  )
  abstract fun cancel(ids: List<String>, now: Long): Int
}
