module.exports = {
  preset: '@react-native/jest-preset',
  moduleNameMapper: {
    '^@react-native-async-storage/async-storage$': '<rootDir>/__mocks__/async-storage.js',
  },
  setupFilesAfterEnv: [
    '<rootDir>/node_modules/react-native-gesture-handler/jestSetup.js',
    '<rootDir>/jest.setup.ts',
  ],
  transformIgnorePatterns: ['node_modules/(?!(@react-navigation|react-native|@react-native|@shopify/flash-list|react-native-gesture-handler|react-native-video)/)'],
};
