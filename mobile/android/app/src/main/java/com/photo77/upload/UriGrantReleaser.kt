package com.photo77.upload

import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import com.photo77.upload.db.UploadTaskEntity

/** Releases one persisted read grant; implementations must treat it as best effort. */
fun interface UriGrantReleaser {
  fun release(uri: Uri)
}

/** Serializes queue insertion with the final reference check and grant release. */
object UriGrantRegistry {
  private val lock = Any()

  fun <T> synchronized(block: () -> T): T = kotlin.synchronized(lock, block)
}

class ContentResolverUriGrantReleaser(
  private val resolver: ContentResolver,
) : UriGrantReleaser {
  override fun release(uri: Uri) {
    if (uri.scheme != ContentResolver.SCHEME_CONTENT) return
    runCatching {
      resolver.releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
  }
}

class QueueAwareUriGrantReleaser(
  private val hasRetainableUri: (String) -> Boolean,
  private val delegate: UriGrantReleaser,
) : UriGrantReleaser {
  override fun release(uri: Uri) {
    UriGrantRegistry.synchronized {
      if (!hasRetainableUri(uri.toString())) delegate.release(uri)
    }
  }
}

/** Releases both sides of a logical upload exactly once. */
internal fun releaseTaskUriGrants(task: UploadTaskEntity, releaser: UriGrantReleaser) {
  listOfNotNull(task.contentUri, task.motionUri)
    .distinct()
    .forEach { releaser.release(Uri.parse(it)) }
}

/** Releases grants only after all retryable tasks using the URI are terminal. */
internal fun releaseTaskUriGrantsIfUnused(
  task: UploadTaskEntity,
  hasRetainableUri: (String) -> Boolean,
  releaser: UriGrantReleaser,
) {
  UriGrantRegistry.synchronized {
    listOfNotNull(task.contentUri, task.motionUri)
      .distinct()
      .filterNot(hasRetainableUri)
      .forEach { releaser.release(Uri.parse(it)) }
  }
}

/** Only canceled Room tasks are safe to release from an explicit cancel call. */
internal fun releaseCanceledTaskUriGrants(
  tasks: Iterable<UploadTaskEntity>,
  releaser: UriGrantReleaser,
  hasRetainableUri: (String) -> Boolean = { false },
) {
  tasks.filter { it.state == com.photo77.upload.db.UploadTaskState.CANCELED }
    .forEach { releaseTaskUriGrantsIfUnused(it, hasRetainableUri, releaser) }
}

/** Recovers grants left behind if the process died after a successful terminal transition. */
internal fun releaseCompletedTaskUriGrants(
  tasks: Iterable<UploadTaskEntity>,
  releaser: UriGrantReleaser,
  hasRetainableUri: (String) -> Boolean = { false },
) {
  tasks.filter {
    it.state == com.photo77.upload.db.UploadTaskState.SUCCEEDED ||
      it.state == com.photo77.upload.db.UploadTaskState.CANCELED
  }.forEach { releaseTaskUriGrantsIfUnused(it, hasRetainableUri, releaser) }
}
