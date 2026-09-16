package com.photo77.upload

import com.photo77.upload.db.UploadTaskEntity
import com.photo77.upload.db.UploadTaskState
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class UploadSchedulerTest {
  @Test
  fun activeUploadsNeverExceedConfiguredConcurrency() {
    val source = FakeTaskSource(tasks("server-a", 8))
    val active = AtomicInteger(0)
    val maximum = AtomicInteger(0)
    val started = CountDownLatch(2)
    val release = CountDownLatch(1)
    val scheduler = UploadScheduler(
      source = source,
      uploader = UploadTaskUploader { task, _ ->
        val current = active.incrementAndGet()
        maximum.updateAndGet { old -> maxOf(old, current) }
        started.countDown()
        release.await(5, TimeUnit.SECONDS)
        active.decrementAndGet()
        UploadResult.success()
      },
      sleepMillis = 1,
    )

    val run = scheduler.start("server-a", "worker-1", 2)
    assertTrue(started.await(5, TimeUnit.SECONDS))
    assertEquals(2, maximum.get())
    release.countDown()
    run.get(5, TimeUnit.SECONDS)
    assertEquals(2, maximum.get())
  }

  @Test
  fun loweringConcurrencyDoesNotCancelExistingTransfers() {
    val source = FakeTaskSource(tasks("server-a", 6))
    val active = AtomicInteger(0)
    val maximum = AtomicInteger(0)
    val firstFour = CountDownLatch(4)
    val release = CountDownLatch(1)
    val scheduler = UploadScheduler(
      source = source,
      uploader = UploadTaskUploader { _, _ ->
        val current = active.incrementAndGet()
        maximum.updateAndGet { old -> maxOf(old, current) }
        firstFour.countDown()
        release.await(5, TimeUnit.SECONDS)
        active.decrementAndGet()
        UploadResult.success()
      },
      sleepMillis = 1,
    )

    val run = scheduler.start("server-a", "worker-1", 4)
    assertTrue(firstFour.await(5, TimeUnit.SECONDS))
    scheduler.setConcurrency(1)
    release.countDown()
    run.get(5, TimeUnit.SECONDS)
    assertEquals(4, maximum.get())
    assertEquals(6, source.tasks.count { it.state == UploadTaskState.SUCCEEDED })
  }

  @Test
  fun preservesPermanentDispositionWithoutRetrying() {
    val source = FakeTaskSource(tasks("server-a", 1).map { task ->
      task.copy(
        motionUri = "content://media/1-motion",
        motionDisplayName = "photo-1.mov",
        motionMimeType = "video/quicktime",
        motionSizeBytes = 200L,
      )
    })
    val released = mutableListOf<String>()
    val scheduler = UploadScheduler(
      source = source,
      uploader = UploadTaskUploader { _, _ -> UploadResult.permanent("URI_ACCESS_DENIED") },
      sleepMillis = 1,
      onTaskTerminal = { task ->
        releaseTaskUriGrants(task, UriGrantReleaser { released += it.toString() })
      },
    )

    scheduler.start("server-a", "worker-1", 1).get(5, TimeUnit.SECONDS)

    assertEquals(UploadTaskState.FAILED, source.tasks.single().state)
    assertEquals("URI_ACCESS_DENIED", source.tasks.single().lastErrorCode)
    assertTrue(released.isEmpty())
  }

  @Test
  fun successfulPairedUploadReleasesStillAndMotionGrants() {
    val source = FakeTaskSource(tasks("server-a", 1).map { task ->
      task.copy(
        motionUri = "content://media/1-motion",
        motionDisplayName = "photo-1.mov",
        motionMimeType = "video/quicktime",
        motionSizeBytes = 200L,
      )
    })
    val released = mutableListOf<String>()
    val scheduler = UploadScheduler(
      source = source,
      uploader = UploadTaskUploader { _, _ -> UploadResult.success() },
      sleepMillis = 1,
      onTaskTerminal = { task ->
        releaseTaskUriGrants(task, UriGrantReleaser { released += it.toString() })
      },
    )

    scheduler.start("server-a", "worker-1", 1).get(5, TimeUnit.SECONDS)

    assertEquals(UploadTaskState.SUCCEEDED, source.tasks.single().state)
    assertEquals(listOf("content://media/1", "content://media/1-motion"), released)
  }

  @Test
  fun retryableUploadKeepsGrantsForTheQueuedRetry() {
    val source = FakeTaskSource(tasks("server-a", 1))
    val released = mutableListOf<String>()
    val scheduler = UploadScheduler(
      source = source,
      uploader = UploadTaskUploader { _, _ -> UploadResult.retryable("NETWORK_ERROR") },
      sleepMillis = 1,
      onTaskTerminal = { task ->
        releaseTaskUriGrants(task, UriGrantReleaser { released += it.toString() })
      },
    )

    scheduler.start("server-a", "worker-1", 1).get(5, TimeUnit.SECONDS)

    assertEquals(UploadTaskState.QUEUED, source.tasks.single().state)
    assertTrue(released.isEmpty())
  }

  @Test
  fun authenticationPauseKeepsGrantsForResume() {
    val source = FakeTaskSource(tasks("server-a", 1))
    val released = mutableListOf<String>()
    val scheduler = UploadScheduler(
      source = source,
      uploader = UploadTaskUploader { _, _ -> UploadResult.authRequired() },
      sleepMillis = 1,
      onTaskTerminal = { task ->
        releaseTaskUriGrants(task, UriGrantReleaser { released += it.toString() })
      },
    )

    scheduler.start("server-a", "worker-1", 1).get(5, TimeUnit.SECONDS)

    assertEquals(UploadTaskState.PAUSED, source.tasks.single().state)
    assertTrue(released.isEmpty())
  }

  @Test
  fun stoppingSchedulerDoesNotCommitAnInFlightUpload() {
    val source = FakeTaskSource(tasks("server-a", 1))
    val started = CountDownLatch(1)
    val release = CountDownLatch(1)
    val scheduler = UploadScheduler(
      source = source,
      uploader = UploadTaskUploader { _, _ ->
        started.countDown()
        release.await(5, TimeUnit.SECONDS)
        UploadResult.success()
      },
      sleepMillis = 1,
    )

    scheduler.start("server-a", "worker-1", 1)
    assertTrue(started.await(5, TimeUnit.SECONDS))
    scheduler.stop()
    release.countDown()

    assertEquals(UploadTaskState.QUEUED, source.tasks.single().state)
  }

  @Test
  fun reportsWhenTheInitialLeaseDecisionHasCompleted() {
    val source = FakeTaskSource(tasks("server-a", 1))
    val initialized = CountDownLatch(1)
    val scheduler = UploadScheduler(
      source = source,
      uploader = UploadTaskUploader { _, _ -> UploadResult.success() },
      sleepMillis = 1,
      onInitialLeaseDecision = { initialized.countDown() },
    )

    scheduler.start("server-a", "worker-1", 1)

    assertTrue(initialized.await(5, TimeUnit.SECONDS))
    scheduler.stop()
  }

  private fun tasks(serverId: String, count: Int): List<UploadTaskEntity> = (1..count).map { index ->
    UploadTaskEntity(
      id = "task-$index",
      batchId = "batch-1",
      contentUri = "content://media/$index",
      displayName = "photo-$index.jpg",
      mimeType = "image/jpeg",
      sizeBytes = 100,
      motionUri = null,
      motionDisplayName = null,
      motionMimeType = null,
      motionSizeBytes = null,
      serverId = serverId,
      userId = "user-1",
      deviceId = "device-1",
      sessionId = null,
      folderId = "folder-1",
      state = UploadTaskState.QUEUED,
      sentBytes = 0,
      attempts = 0,
      lastErrorCode = null,
      lastErrorMessage = null,
      createdAtEpochMs = index.toLong(),
      startedAtEpochMs = null,
      completedAtEpochMs = null,
      nextRetryAtEpochMs = null,
      leaseOwner = null,
      leaseUntilEpochMs = null,
    )
  }

  private class FakeTaskSource(initial: List<UploadTaskEntity>) : UploadTaskSource {
    val tasks = Collections.synchronizedList(initial.toMutableList())

    override fun recoverExpiredLeases(now: Long) = Unit

    override fun acquireQueued(serverId: String, owner: String, limit: Int, now: Long, leaseUntil: Long): List<UploadTaskEntity> {
      synchronized(tasks) {
        val selected = tasks.filter { it.serverId == serverId && it.state == UploadTaskState.QUEUED }.take(limit)
        selected.forEach { task ->
          val index = tasks.indexOfFirst { it.id == task.id }
          tasks[index] = task.copy(state = UploadTaskState.UPLOADING, leaseOwner = owner, leaseUntilEpochMs = leaseUntil)
        }
        return selected.map { it.copy(state = UploadTaskState.UPLOADING, leaseOwner = owner, leaseUntilEpochMs = leaseUntil) }
      }
    }

    override fun updateState(task: UploadTaskEntity, nextState: String, now: Long, errorCode: String?, errorMessage: String?, nextRetryAt: Long?) {
      synchronized(tasks) {
        val index = tasks.indexOfFirst { it.id == task.id }
        tasks[index] = tasks[index].copy(state = nextState, lastErrorCode = errorCode, lastErrorMessage = errorMessage, nextRetryAtEpochMs = nextRetryAt)
      }
    }

    override fun hasRunnable(serverId: String, now: Long): Boolean = tasks.any {
      it.serverId == serverId && it.state == UploadTaskState.QUEUED &&
        (it.nextRetryAtEpochMs == null || it.nextRetryAtEpochMs <= now)
    }

    override fun releaseLeases(owner: String) {
      synchronized(tasks) {
        tasks.replaceAll { task ->
          if (task.leaseOwner == owner && task.state == UploadTaskState.UPLOADING) {
            task.copy(state = UploadTaskState.QUEUED, leaseOwner = null, leaseUntilEpochMs = null)
          } else {
            task
          }
        }
      }
    }
  }
}
