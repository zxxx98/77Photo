describe('NativeUploadQueue module lookup', () => {
  afterEach(() => {
    jest.dontMock('react-native');
    jest.resetModules();
  });

  it('falls back to the registered NativeModules bridge when the turbo lookup is empty', () => {
    const nativeQueue = { enqueue: jest.fn() };
    jest.doMock('react-native', () => ({
      NativeModules: { NativeUploadQueue: nativeQueue },
      TurboModuleRegistry: { get: jest.fn(() => null) },
    }));

    let resolved: unknown;
    jest.isolateModules(() => {
      resolved = require('./NativeUploadQueue').default;
    });

    expect(resolved).toBe(nativeQueue);
  });
});
