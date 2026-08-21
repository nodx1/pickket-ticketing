import { View, type ViewStyle } from "react-native";
import { useTheme } from "@/hooks/useTheme";

interface Props {
  style?: ViewStyle;
}

export function Divider({ style }: Props) {
  const { colors } = useTheme();

  return (
    <View
      style={[
        { height: 1, backgroundColor: colors.border },
        style,
      ]}
    />
  );
}
