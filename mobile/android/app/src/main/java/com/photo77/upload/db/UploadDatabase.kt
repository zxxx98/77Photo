package com.photo77.upload.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(entities = [UploadTaskEntity::class], version = 1, exportSchema = false)
abstract class UploadDatabase : RoomDatabase() {
  abstract fun uploadTaskDao(): UploadTaskDao

  companion object {
    @Volatile private var instance: UploadDatabase? = null

    fun getInstance(context: Context): UploadDatabase =
      instance ?: synchronized(this) {
        instance ?: Room.databaseBuilder(
          context.applicationContext,
          UploadDatabase::class.java,
          DATABASE_NAME,
        ).build().also { instance = it }
      }

    fun newInMemory(context: Context): UploadDatabase =
      Room.inMemoryDatabaseBuilder(context, UploadDatabase::class.java)
        .allowMainThreadQueries()
        .build()

    private const val DATABASE_NAME = "photo77_uploads.db"
  }
}
