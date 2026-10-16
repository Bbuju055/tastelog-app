const React = require("react");
const { Text } = require("react-native");

function createIconMock(name) {
  function IconComponent(props) {
    return React.createElement(Text, {
      accessibilityLabel: props.accessibilityLabel,
      testID: props.testID,
    }, props.name);
  }
  IconComponent.displayName = name;
  return IconComponent;
}

module.exports = {
  Ionicons: createIconMock("Ionicons"),
  MaterialIcons: createIconMock("MaterialIcons"),
  FontAwesome: createIconMock("FontAwesome"),
};
