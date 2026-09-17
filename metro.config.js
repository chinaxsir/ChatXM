const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// markdown-it 依赖 punycode（Node 内置），RN 环境需 polyfill
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules || {}),
  punycode: require.resolve('punycode'),
};

module.exports = config;
