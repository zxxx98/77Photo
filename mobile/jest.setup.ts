import i18n from './src/i18n';

beforeEach(async () => {
  await i18n.changeLanguage('zh');
});
