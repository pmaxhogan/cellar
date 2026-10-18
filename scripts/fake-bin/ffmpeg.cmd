@echo off
rem Thin launcher. The shim logic lives in ffmpeg.mjs (Node ESM).
set "FAKE_BIN_NODE_EXE=node"
if defined FAKE_BIN_NODE set "FAKE_BIN_NODE_EXE=%FAKE_BIN_NODE%"
"%FAKE_BIN_NODE_EXE%" "%~dp0ffmpeg.mjs" %*
