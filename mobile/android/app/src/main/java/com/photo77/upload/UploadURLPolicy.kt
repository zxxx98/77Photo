package com.photo77.upload

import java.net.InetAddress
import java.net.URI
import java.util.Locale

/** Re-checks the server boundary before native foreground or recovery work can use it. */
object UploadURLPolicy {
  private val ipv4Literal = Regex("(?:\\d{1,3}\\.){3}\\d{1,3}")
  private val ipv6Literal = Regex("[0-9a-fA-F:.]+")

  fun requireAllowed(raw: String, allowedLANCIDRs: Collection<String>): String {
    val normalized = normalize(raw)
    val uri = URI(normalized)
    val scheme = uri.scheme.lowercase(Locale.US)
    if (scheme == "https") return normalized

    val host = uri.host?.removeSurrounding("[", "]") ?: throw IllegalArgumentException("server URL host is invalid")
    val ip = parseLiteral(host) ?: throw IllegalArgumentException("HTTP server URL must use an IP address")
    if (allowedLANCIDRs.none { cidrContains(it, ip) }) {
      throw IllegalArgumentException("HTTP server URL is outside the allowed LAN ranges")
    }
    return normalized
  }

  private fun normalize(raw: String): String {
    val uri = try {
      URI(raw.trim())
    } catch (_: Exception) {
      throw IllegalArgumentException("server URL is invalid")
    }
    val scheme = uri.scheme?.lowercase(Locale.US)
    if (scheme != "http" && scheme != "https") throw IllegalArgumentException("server URL scheme is invalid")
    if (!uri.isAbsolute || uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null) {
      throw IllegalArgumentException("server URL contains unsupported components")
    }
    val host = uri.host?.removeSurrounding("[", "]")?.lowercase(Locale.US)
      ?.takeIf { it.isNotBlank() }
      ?: throw IllegalArgumentException("server URL host is invalid")
    if (uri.port == 0 || uri.port > 65535) throw IllegalArgumentException("server URL port is invalid")
    val authorityHost = if (host.contains(':')) "[$host]" else host
    val port = if (uri.port == -1) "" else ":${uri.port}"
    val path = uri.rawPath.orEmpty().trimEnd('/')
    return "$scheme://$authorityHost$port$path"
  }

  private fun parseLiteral(raw: String): ByteArray? {
    val isIPv4 = ipv4Literal.matches(raw)
    val isIPv6 = raw.contains(':') && ipv6Literal.matches(raw)
    if (!isIPv4 && !isIPv6) return null
    return runCatching {
      InetAddress.getByName(raw).address.takeIf { bytes ->
        (isIPv4 && bytes.size == 4) || (isIPv6 && bytes.size == 16)
      }
    }.getOrNull()
  }

  private fun cidrContains(raw: String, ip: ByteArray): Boolean {
    val slash = raw.lastIndexOf('/')
    if (slash <= 0 || slash == raw.lastIndex) return false
    val network = parseLiteral(raw.substring(0, slash)) ?: return false
    if (network.size != ip.size) return false
    val prefix = raw.substring(slash + 1).toIntOrNull() ?: return false
    if (prefix !in 0..network.size * 8) return false
    val fullBytes = prefix / 8
    val remainingBits = prefix % 8
    for (index in 0 until fullBytes) {
      if (network[index] != ip[index]) return false
    }
    if (remainingBits == 0) return true
    val mask = (0xff shl (8 - remainingBits)) and 0xff
    return (network[fullBytes].toInt() and mask) == (ip[fullBytes].toInt() and mask)
  }
}
