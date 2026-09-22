package com.photo77.upload

import com.photo77.upload.db.UploadTaskEntity
import com.photo77.upload.db.UploadTaskState
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class UriGrantReleaserTest {
  @Test
  fun canceledQueuedPausedAndFailedTasksReleaseBothUris() {
    val released = mutableListOf<String>()
    val releaser = UriGrantReleaser { released += it.toString() }
    val tasks = listOf(
      task("queued", UploadTaskState.CANCELED, "content://media/queued", "content://media/queued-motion"),
      task("paused", UploadTaskState.CANCELED, "content://media/paused", "content://media/paused-motion"),
      task("failed", UploadTaskState.CANCELED, "content://media/failed", "content://media/failed-motion"),
    )

    releaseCanceledTaskUriGrants(tasks, releaser)

    assertEquals(
      listOf(
        "content://media/queued", "content://media/queued-motion",
        "content://media/paused", "content://media/paused-motion",
        "content://media/failed", "content://media/failed-motion",
      ),
      released,
    )
  }

  @Test
  fun activeAndRecoverableTasksAreNotReleased() {
    val released = mutableListOf<String>()
    val releaser = UriGrantReleaser { released += it.toString() }
    val tasks = listOf(
      task("uploading", UploadTaskState.UPLOADING, "content://media/uploading", "content://media/uploading-motion"),
      task("queued", UploadTaskState.QUEUED, "content://media/queued", "content://media/queued-motion"),
      task("paused", UploadTaskState.PAUSED, "content://media/paused", "content://media/paused-motion"),
    )

    releaseCanceledTaskUriGrants(tasks, releaser)

    assertEquals(emptyList<String>(), released)
  }

  @Test
  fun completedTasksCanBeCleanedUpAfterAProcessRestart() {
    val released = mutableListOf<String>()
    val releaser = UriGrantReleaser { released += it.toString() }
    val tasks = listOf(
      task("succeeded", UploadTaskState.SUCCEEDED, "content://media/succeeded", "content://media/succeeded-motion"),
      task("canceled", UploadTaskState.CANCELED, "content://media/canceled", "content://media/canceled-motion"),
      task("failed", UploadTaskState.FAILED, "content://media/failed", "content://media/failed-motion"),
    )

    releaseCompletedTaskUriGrants(tasks, releaser)

    assertEquals(
      listOf(
        "content://media/succeeded", "content://media/succeeded-motion",
        "content://media/canceled", "content://media/canceled-motion",
      ),
      released,
    )
  }

  @Test
  fun sharedUriIsKeptWhileAnotherRetryableTaskStillReferencesIt() {
    val released = mutableListOf<String>()
    val releaser = UriGrantReleaser { released += it.toString() }
    val canceled = task(
      "canceled",
      UploadTaskState.CANCELED,
      "content://media/shared",
      "content://media/motion",
    )

    releaseCanceledTaskUriGrants(
      listOf(canceled),
      releaser,
      hasRetainableUri = { it == "content://media/shared" },
    )

    assertEquals(listOf("content://media/motion"), released)
  }

  private fun task(id: String, state: String, uri: String, motionUri: String) = UploadTaskEntity(
    id = id,
    batchId = "batch-1",
    contentUri = uri,
    displayName = "$id.jpg",
    mimeType = "image/jpeg",
    sizeBytes = 100L,
    motionUri = motionUri,
    motionDisplayName = "$id.mov",
    motionMimeType = "video/quicktime",
    motionSizeBytes = 20L,
    serverId = "server-1",
    userId = null,
    deviceId = "device-1",
    sessionId = null,
    folderId = "folder-1",
    state = state,
    sentBytes = 0L,
    attempts = 0,
    lastErrorCode = null,
    lastErrorMessage = null,
    createdAtEpochMs = 1L,
    startedAtEpochMs = null,
    completedAtEpochMs = null,
    nextRetryAtEpochMs = null,
    leaseOwner = null,
    leaseUntilEpochMs = null,
  )
}
