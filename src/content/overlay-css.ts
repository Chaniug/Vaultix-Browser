/**
 * 页内浮层样式。
 * 挂在封闭 Shadow DOM 内：页面样式不会渗入，浮层样式也不会污染页面。
 * 不加载任何外部字体或样式（M-4）；配色与扩展自身的界面保持一致。
 */
export const OVERLAY_CSS = `:host {
  all: initial !important;
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  width: 0 !important;
  height: 0 !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  z-index: 2147483647 !important;
}
.vx-root {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: 13px;
  line-height: 1.5;
  color: #e8edf5;
}
.vx-icon {
  position: fixed;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: #2fc79d;
  color: #07251d;
  cursor: pointer;
}
.vx-icon.muted {
  background: #39414f;
  color: #e8edf5;
}
.vx-icon.totp {
  background: #4b78c4;
  color: #ffffff;
}
.vx-icon:hover {
  background: #5ee3be;
}
.vx-icon.muted:hover {
  background: #4a5568;
}
.vx-icon.totp:hover {
  background: #6a93d6;
}
.vx-icon svg {
  width: 12px;
  height: 12px;
}
.vx-panel {
  position: fixed;
  box-sizing: border-box;
  overflow-y: auto;
  padding: 8px;
  border: 1px solid #2fc79d;
  border-radius: 12px;
  background: #161d2d;
}
.vx-panel-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 6px 6px;
  font-size: 12px;
  color: #9aa6b8;
}
.vx-row {
  border-radius: 9px;
  padding: 8px;
  margin-bottom: 6px;
  background: #1d2639;
  cursor: pointer;
}
.vx-row:hover,
.vx-row.active {
  background: #243049;
  outline: 1px solid #2fc79d;
}
.vx-row-main {
  display: flex;
  align-items: center;
  gap: 6px;
}
.vx-badge {
  flex: none;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
}
.vx-badge.kp {
  background: #2fc79d;
  color: #07251d;
}
.vx-badge.bw {
  background: #4b78c4;
  color: #ffffff;
}
.vx-row-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 500;
}
.vx-row-actions {
  flex: none;
  display: flex;
  gap: 4px;
  margin-left: auto;
}
.vx-btn {
  font: inherit;
  font-size: 12px;
  padding: 3px 9px;
  border: 1px solid #39414f;
  border-radius: 6px;
  background: transparent;
  color: #c5cedc;
  cursor: pointer;
  white-space: nowrap;
}
.vx-btn.compact {
  padding: 3px 6px;
}
.vx-btn.primary {
  border-color: #2fc79d;
  background: #2fc79d;
  color: #07251d;
}
.vx-btn:hover {
  border-color: #5ee3be;
  color: #e8edf5;
}
.vx-btn.primary:hover {
  border-color: #5ee3be;
  background: #5ee3be;
}
.vx-row-user {
  margin-top: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: #9aa6b8;
}
.vx-empty {
  padding: 14px 10px;
  text-align: center;
  font-size: 12px;
  color: #9aa6b8;
}
.vx-foot {
  margin-top: 6px;
  padding: 8px 6px 2px;
  border-top: 1px solid #2a3448;
}
.vx-foot-btn {
  width: 100%;
  padding: 0;
  border: 0;
  background: none;
  color: #9aa6b8;
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.vx-foot-btn:hover {
  color: #5ee3be;
}
.vx-bar {
  position: fixed;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid #2fc79d;
  border-radius: 12px;
  background: #161d2d;
}
.vx-bar.vx-toast {
  border-color: #39414f;
  color: #c5cedc;
  font-size: 12px;
  justify-content: center;
}
.vx-bar-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vx-bar-actions {
  flex: none;
  display: flex;
  gap: 6px;
}
.vx-src {
  flex: none;
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 8px;
  background: #0f141f;
}
.vx-src button {
  padding: 3px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #9aa6b8;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.vx-src button.active {
  background: #243049;
  color: #e8edf5;
}
.vx-hidden {
  display: none;
}
`;
