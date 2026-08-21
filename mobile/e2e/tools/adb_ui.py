#!/usr/bin/env python3

import argparse
import os
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path


ANDROID_SDK = "/home/oem/Android/Sdk"


def build_env() -> dict[str, str]:
    env = os.environ.copy()
    env["ANDROID_HOME"] = ANDROID_SDK
    env["ANDROID_SDK_ROOT"] = ANDROID_SDK
    env["PATH"] = f"{ANDROID_SDK}/platform-tools:{ANDROID_SDK}/emulator:{env['PATH']}"
    return env


def adb(device: str, *args: str, check: bool = True, text: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["adb", "-s", device, *args],
        check=check,
        text=text,
        capture_output=True,
        env=build_env(),
    )


def dump_xml(device: str, retries: int = 3) -> ET.Element:
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            adb(device, "shell", "uiautomator", "dump", "/sdcard/view.xml")
            xml = adb(device, "shell", "cat", "/sdcard/view.xml").stdout
            return ET.fromstring(xml)
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            time.sleep(0.5 * (attempt + 1))
    if last_error is not None:
        raise last_error
    raise RuntimeError("Failed to dump UI hierarchy")


def parse_bounds(bounds: str) -> tuple[int, int, int, int]:
    match = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", bounds)
    if not match:
        raise ValueError(f"Unexpected bounds: {bounds}")
    return tuple(map(int, match.groups()))  # type: ignore[return-value]


def center(bounds: str) -> tuple[int, int]:
    x1, y1, x2, y2 = parse_bounds(bounds)
    return (x1 + x2) // 2, (y1 + y2) // 2


def node_matches(
    node: ET.Element,
    resource_id: str | None,
    text_value: str | None,
    desc: str | None,
    contains: str | None,
) -> bool:
    if resource_id and node.attrib.get("resource-id") != resource_id:
        return False
    if text_value and node.attrib.get("text") != text_value:
        return False
    if desc and node.attrib.get("content-desc") != desc:
        return False
    if contains:
        haystack = " ".join(
            [
                node.attrib.get("resource-id", ""),
                node.attrib.get("text", ""),
                node.attrib.get("content-desc", ""),
            ]
        )
        if contains not in haystack:
            return False
    return True


def find_node(
    root: ET.Element,
    resource_id: str | None,
    text_value: str | None,
    desc: str | None,
    contains: str | None,
) -> ET.Element | None:
    for node in root.iter("node"):
        if node_matches(node, resource_id, text_value, desc, contains):
            return node
    return None


def wait_for_node(
    device: str,
    resource_id: str | None,
    text_value: str | None,
    desc: str | None,
    contains: str | None,
    timeout: float,
) -> ET.Element | None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        root = dump_xml(device)
        node = find_node(root, resource_id, text_value, desc, contains)
        if node is not None:
            return node
        time.sleep(0.5)
    return None


def shell_input_text(device: str, value: str) -> None:
    escaped = (
        value.replace("\\", "\\\\")
        .replace(" ", "%s")
        .replace("&", "\\&")
        .replace("(", "\\(")
        .replace(")", "\\)")
        .replace("<", "\\<")
        .replace(">", "\\>")
        .replace("|", "\\|")
        .replace(";", "\\;")
        .replace('"', '\\"')
        .replace("'", "\\'")
    )
    adb(device, "shell", "input", "text", escaped)


def require_node(args: argparse.Namespace) -> ET.Element:
    node = wait_for_node(
        args.device,
        args.id,
        args.text,
        args.desc,
        args.contains,
        args.timeout,
    )
    if node is None:
        print("Element not found", file=sys.stderr)
        sys.exit(1)
    return node


def cmd_exists(args: argparse.Namespace) -> None:
    node = wait_for_node(args.device, args.id, args.text, args.desc, args.contains, args.timeout)
    if node is None:
        sys.exit(1)
    print(node.attrib)


def cmd_tap(args: argparse.Namespace) -> None:
    node = require_node(args)
    x, y = center(node.attrib["bounds"])
    adb(args.device, "shell", "input", "tap", str(x), str(y))
    print(f"{x},{y}")


def cmd_input(args: argparse.Namespace) -> None:
    node = require_node(args)
    x, y = center(node.attrib["bounds"])
    adb(args.device, "shell", "input", "tap", str(x), str(y))
    time.sleep(0.5)
    if args.clear:
        for _ in range(args.clear_chars):
            adb(args.device, "shell", "input", "keyevent", "67")
    shell_input_text(args.device, args.value)


def cmd_swipe(args: argparse.Namespace) -> None:
    adb(
        args.device,
        "shell",
        "input",
        "swipe",
        str(args.x1),
        str(args.y1),
        str(args.x2),
        str(args.y2),
        str(args.duration),
    )


def cmd_keyevent(args: argparse.Namespace) -> None:
    adb(args.device, "shell", "input", "keyevent", str(args.code))


def cmd_screenshot(args: argparse.Namespace) -> None:
    output = Path(args.path)
    output.parent.mkdir(parents=True, exist_ok=True)
    data = adb(args.device, "exec-out", "screencap", "-p", text=False).stdout
    output.write_bytes(data if isinstance(data, bytes) else data.encode())
    print(output)


def cmd_open_url(args: argparse.Namespace) -> None:
    adb(args.device, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", args.url)


def cmd_home(args: argparse.Namespace) -> None:
    adb(args.device, "shell", "input", "keyevent", "3")


def cmd_back(args: argparse.Namespace) -> None:
    adb(args.device, "shell", "input", "keyevent", "4")


def cmd_dump(args: argparse.Namespace) -> None:
    root = dump_xml(args.device)
    for node in root.iter("node"):
        if not node_matches(node, args.id, args.text, args.desc, args.contains):
            continue
        print(
            {
                "resource-id": node.attrib.get("resource-id"),
                "text": node.attrib.get("text"),
                "content-desc": node.attrib.get("content-desc"),
                "bounds": node.attrib.get("bounds"),
            }
        )


def parser_with_selector(name: str, help_text: str) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog=name, description=help_text)
    parser.add_argument("--device", required=True)
    parser.add_argument("--id")
    parser.add_argument("--text")
    parser.add_argument("--desc")
    parser.add_argument("--contains")
    parser.add_argument("--timeout", type=float, default=10.0)
    return parser


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    exists = subparsers.add_parser("exists")
    exists.add_argument("--device", required=True)
    exists.add_argument("--id")
    exists.add_argument("--text")
    exists.add_argument("--desc")
    exists.add_argument("--contains")
    exists.add_argument("--timeout", type=float, default=10.0)
    exists.set_defaults(func=cmd_exists)

    tap = subparsers.add_parser("tap")
    tap.add_argument("--device", required=True)
    tap.add_argument("--id")
    tap.add_argument("--text")
    tap.add_argument("--desc")
    tap.add_argument("--contains")
    tap.add_argument("--timeout", type=float, default=10.0)
    tap.set_defaults(func=cmd_tap)

    input_cmd = subparsers.add_parser("input")
    input_cmd.add_argument("--device", required=True)
    input_cmd.add_argument("--id")
    input_cmd.add_argument("--text")
    input_cmd.add_argument("--desc")
    input_cmd.add_argument("--contains")
    input_cmd.add_argument("--timeout", type=float, default=10.0)
    input_cmd.add_argument("--value", required=True)
    input_cmd.add_argument("--clear", action="store_true")
    input_cmd.add_argument("--clear-chars", type=int, default=64)
    input_cmd.set_defaults(func=cmd_input)

    swipe = subparsers.add_parser("swipe")
    swipe.add_argument("--device", required=True)
    swipe.add_argument("--x1", type=int, required=True)
    swipe.add_argument("--y1", type=int, required=True)
    swipe.add_argument("--x2", type=int, required=True)
    swipe.add_argument("--y2", type=int, required=True)
    swipe.add_argument("--duration", type=int, default=300)
    swipe.set_defaults(func=cmd_swipe)

    keyevent = subparsers.add_parser("keyevent")
    keyevent.add_argument("--device", required=True)
    keyevent.add_argument("--code", required=True)
    keyevent.set_defaults(func=cmd_keyevent)

    screenshot = subparsers.add_parser("screenshot")
    screenshot.add_argument("--device", required=True)
    screenshot.add_argument("--path", required=True)
    screenshot.set_defaults(func=cmd_screenshot)

    open_url = subparsers.add_parser("open-url")
    open_url.add_argument("--device", required=True)
    open_url.add_argument("--url", required=True)
    open_url.set_defaults(func=cmd_open_url)

    home = subparsers.add_parser("home")
    home.add_argument("--device", required=True)
    home.set_defaults(func=cmd_home)

    back = subparsers.add_parser("back")
    back.add_argument("--device", required=True)
    back.set_defaults(func=cmd_back)

    dump = subparsers.add_parser("dump")
    dump.add_argument("--device", required=True)
    dump.add_argument("--id")
    dump.add_argument("--text")
    dump.add_argument("--desc")
    dump.add_argument("--contains")
    dump.set_defaults(func=cmd_dump)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
