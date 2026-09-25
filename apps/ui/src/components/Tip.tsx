// Tooltip that opens on keyboard focus as well as on mouse hover, so nothing that a tooltip says is for the mouse
// only. (Ant Design's Tooltip opens on hover only.) Escape closes it. Same props as Ant Design's Tooltip.

import { Tooltip as AntTooltip, type TooltipProps } from 'antd';

export function Tooltip(props: TooltipProps) {
  return <AntTooltip trigger={['hover', 'focus']} {...props} />;
}
