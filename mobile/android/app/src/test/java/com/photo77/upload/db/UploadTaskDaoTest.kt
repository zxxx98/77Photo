package com.photo77.upload.db

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class UploadTaskDaoTest {
  private lateinit var database: UploadDatabase
  private lateinit var dao: UploadTaskDao

  @Before
  fun setUp() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    database = Room.inMemoryDatabaseBuilder(context, UploadDatabase::class.java)
      .allowMainThreadQueries()
      .build()
    dao = database.uploadTaskDao()
  }

  @After
  fun tearDown() {
    database.close()
  }

  @Test
  fun acquireQueuedLeasesOnlyMatchingServerAndAvailableSlots() = runBlocking {
    dao.insertAll(listOf(
      task("task-1", "server-a", 1000),
      task("task-2", "server-a", 1001),
      task("task-3", "server-a", 1002),
      task("other-server", "server-b", 1003),
    ))

    val leased = dao.acquireQueued(
      serverId = "server-a",
      owner = "worker-1",
      limit = 2,
      now = 1000,
      leaseUntil = 31000,
    )

    assertEquals(listOf("task-1", "task-2"), leased.map { it.id })
    val otherOwnerLeased = dao.acquireQueued("server-a", "worker-2", 2, 1001, 31001)
    assertEquals(listOf("task-3"), otherOwnerLeased.map { it.id })
    assertEquals("worker-2", otherOwnerLeased.single().leaseOwner)
    assertEquals(listOf("task-1", "task-2", "task-3"), dao.findByServer("server-a").map { it.id })
  }

  @Test
  fun expiredLeasesCanBeRecoveredAndReacquired() = runBlocking {
    dao.insert(task("task-1", "server-a", 1000))
    assertEquals(1, dao.acquireQueued("server-a", "worker-1", 1, 1000, 31000).size)

    assertEquals(1, dao.recoverExpiredLeases(now = 31001))
    val leased = dao.acquireQueued("server-a", "worker-2", 1, 31001, 61001)
    assertEquals(listOf("task-1"), leased.map { it.id })
    assertEquals("worker-2", leased.single().leaseOwner)
  }

  @Test
  fun staleLeaseOwnerCannotCompleteAReclaimedTask() = runBlocking {
    dao.insert(task("task-1", "server-a", 1000))
    dao.acquireQueued("server-a", "worker-1", 1, 1000, 31000)
    dao.recoverExpiredLeases(31001)
    dao.acquireQueued("server-a", "worker-2", 1, 31001, 61001)

    assertEquals(
      0,
      dao.updateStateWithRetryOwned(
        id = "task-1",
        owner = "worker-1",
        nextState = UploadTaskState.SUCCEEDED,
        now = 32000,
        errorCode = null,
        errorMessage = null,
        nextRetryAt = null,
      ),
    )
    assertEquals(
      1,
      dao.updateStateWithRetryOwned(
        id = "task-1",
        owner = "worker-2",
        nextState = UploadTaskState.SUCCEEDED,
        now = 32001,
        errorCode = null,
        errorMessage = null,
        nextRetryAt = null,
      ),
    )
  }

  @Test
  fun stateUpdatesRequireExpectedCurrentState() = runBlocking {
    dao.insert(task("task-1", "server-a", 1000))

    assertEquals(1, dao.updateState("task-1", UploadTaskState.QUEUED, UploadTaskState.PAUSED, 2000, null, null))
    assertEquals(0, dao.updateState("task-1", UploadTaskState.QUEUED, UploadTaskState.SUCCEEDED, 2001, null, null))
    assertEquals(UploadTaskState.PAUSED, dao.findByServer("server-a").single().state)
  }

  @Test
  fun snapshotNeverMixesServers() = runBlocking {
    dao.insertAll(listOf(task("a", "server-a", 1), task("b", "server-b", 2)))

    assertEquals(listOf("a"), dao.findByServer("server-a").map { it.id })
    assertEquals(listOf("b"), dao.findByServer("server-b").map { it.id })
  }

  @Test
  fun persistsOptionalMotionCompanionOnTheSameLogicalTask() = runBlocking {
    val original = task("task-1", "server-a", 1000).copy(
      motionUri = "content://media/task-1-motion",
      motionDisplayName = "task-1.mov",
      motionMimeType = "video/quicktime",
      motionSizeBytes = 200L,
    )
    dao.insert(original)

    assertEquals(original, dao.findByServer("server-a").single())
  }

  @Test
  fun cancelMovesQueuedPausedAndFailedTasksToCanceled() = runBlocking {
    dao.insertAll(listOf(
      task("queued", "server-a", 1000),
      task("paused", "server-a", 1001).copy(state = UploadTaskState.PAUSED),
      task("failed", "server-a", 1002).copy(state = UploadTaskState.FAILED),
    ))

    assertEquals(3, dao.cancel(listOf("queued", "paused", "failed"), 2000L))
    assertEquals(
      listOf(UploadTaskState.CANCELED, UploadTaskState.CANCELED, UploadTaskState.CANCELED),
      dao.findByServer("server-a").map { it.state },
    )
  }

  private fun task(id: String, serverId: String, createdAt: Long) = UploadTaskEntity(
    id = id,
    batchId = "batch-$serverId",
    contentUri = "content://media/$id",
    displayName = "$id.jpg",
    mimeType = "image/jpeg",
    sizeBytes = 100L,
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
    sentBytes = 0L,
    attempts = 0,
    lastErrorCode = null,
    lastErrorMessage = null,
    createdAtEpochMs = createdAt,
    startedAtEpochMs = null,
    completedAtEpochMs = null,
    nextRetryAtEpochMs = null,
    leaseOwner = null,
    leaseUntilEpochMs = null,
  )
}
