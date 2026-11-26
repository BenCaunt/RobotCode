import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

export function RobotMark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  const aspectRatio = 27 / 25;
  return (
    <Svg
      accessibilityLabel="Robot Code"
      height={props.height}
      width={props.height * aspectRatio}
      viewBox="2 1 27 25"
    >
      <ThemedPath
        d="M18 10L23 2H27L22 10ZM5 9H25Q28 9 28 12V22L25 25H6Q3 25 3 22V12Q3 10 5 9ZM8 14V20H13V14ZM18 14V20H23V14Z"
        fillRule="evenodd"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}
