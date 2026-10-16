module.exports = function (api) {
  api.cache(true);

  const presets = ["babel-preset-expo"];
  const plugins = [];
  const isTest =
    process.env.BABEL_ENV === "test" || process.env.NODE_ENV === "test";

  if (!isTest) {
    presets.push("nativewind/babel");
  }

  plugins.push("react-native-reanimated/plugin");

  return { presets, plugins };
};
