#!/bin/bash
case "$*" in
  'devices -l') echo 'TESTUSB device usb:1-1 model:FakePhone';;
  *get-state*) echo device;;
  *getprop*) echo 1;;
  *'dumpsys power'*) echo 'mWakefulness=Awake';;
  *'dumpsys window policy'*) printf 'KeyguardServiceDelegate\n showing=false\n';;
  *) echo connected;;
esac
