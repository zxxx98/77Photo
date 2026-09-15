module.exports = {
  preset: '@react-native/jest-preset',
  moduleNameMapper: {
    '^@react-native-async-storage/async-storage$': '<rootDir>/__mocks__/async-storage.js',
  },
  transformIgnorePatterns: ['node_modules/(?!(@react-navigation|react-native|@react-native)/)'],
};
