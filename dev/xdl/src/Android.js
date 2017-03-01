/**
 * @flow
 */

import 'instapromise';

import _ from 'lodash';
import spawnAsync from '@exponent/spawn-async';
import existsAsync from 'exists-async';
import mkdirp from 'mkdirp';
import path from 'path';
import semver from 'semver';

import * as Analytics from './Analytics';
import * as Binaries from './Binaries';
import Api from './Api';
import Logger from './Logger';
import NotificationCode from './NotificationCode';
import * as ProjectUtils from './project/ProjectUtils';
import * as ProjectSettings from './ProjectSettings';
import UserSettings from './UserSettings';
import * as UrlUtils from './UrlUtils';

let _lastUrl = null;
const BEGINNING_OF_ADB_ERROR_MESSAGE = 'error: ';
const CANT_START_ACTIVITY_ERROR = 'Activity not started, unable to resolve Intent';

export function isPlatformSupported() {
  return process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux';
}

async function _getAdbOutputAsync(args) {
  await Binaries.addToPathAsync('adb');

  try {
    let result = await spawnAsync('adb', args);
    return result.stdout;
  } catch (e) {
    let errorMessage = _.trim(e.stderr);
    if (errorMessage.startsWith(BEGINNING_OF_ADB_ERROR_MESSAGE)) {
      errorMessage = errorMessage.substring(BEGINNING_OF_ADB_ERROR_MESSAGE.length);
    }
    throw new Error(errorMessage);
  }
}

// Device attached
async function _isDeviceAttachedAsync() {
  let devices = await _getAdbOutputAsync(['devices']);
  let lines = _.trim(devices).split(/\r?\n/);
  // First line is "List of devices".
  return lines.length > 1;
}

async function _isDeviceAuthorizedAsync() {
  let devices = await _getAdbOutputAsync(['devices']);
  let lines = _.trim(devices).split(/\r?\n/);
  lines.shift();
  let listOfDevicesWithoutFirstLine = lines.join('\n');
  // result looks like "072c4cf200e333c7	device" when authorized
  // and "072c4cf200e333c7	unauthorized" when not.
  return listOfDevicesWithoutFirstLine.includes('device');
}

// Exponent installed
async function _isExponentInstalledAsync() {
  let packages = await _getAdbOutputAsync(['shell', 'pm', 'list', 'packages', '-f']);
  let lines = packages.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.includes('host.exp.exponent.test')) {
      continue;
    }

    if (line.includes('host.exp.exponent')) {
      return true;
    }
  }

  return false;
}

async function _exponentVersionAsync() {
  let info = await _getAdbOutputAsync(['shell', 'dumpsys', 'package', 'host.exp.exponent']);

  let regex = /versionName\=([0-9\.]+)/;
  let regexMatch = regex.exec(info);
  if (regexMatch.length < 2) {
    return null;
  }

  return regexMatch[1];
}

async function _checkExponentUpToDateAsync() {
  let versions = await Api.versionsAsync();
  let installedVersion = await _exponentVersionAsync();

  if (!installedVersion || semver.lt(installedVersion, versions.androidVersion)) {
    Logger.notifications.warn({code: NotificationCode.OLD_ANDROID_APP_VERSION}, 'This version of the Exponent app is out of date. Uninstall the app and run again to upgrade.');
  }
}

function _apkCacheDirectory() {
  let dotExponentHomeDirectory = UserSettings.dotExponentHomeDirectory();
  let dir = path.join(dotExponentHomeDirectory, 'android-apk-cache');
  mkdirp.sync(dir);
  return dir;
}

async function _downloadApkAsync() {
  let versions = await Api.versionsAsync();
  let apkPath = path.join(_apkCacheDirectory(), `Exponent-${versions.androidVersion}.apk`);

  if (await existsAsync(apkPath)) {
    return apkPath;
  }

  let url = `https://s3.amazonaws.com/exp-android-apks/Exponent-${versions.androidVersion}.apk`;
  await Api.downloadAsync(url, path.join(_apkCacheDirectory(), `Exponent-${versions.androidVersion}.apk`));
  return apkPath;
}

async function _installExponentAsync() {
  Logger.global.info(`Downloading latest version of Exponent`);
  Logger.notifications.info({code: NotificationCode.START_LOADING});
  let path = await _downloadApkAsync();
  Logger.global.info(`Installing Exponent on device`);
  let result = await _getAdbOutputAsync(['install', path]);
  Logger.notifications.info({code: NotificationCode.STOP_LOADING});
  return result;
}

async function _uninstallExponentAsync() {
  Logger.global.info('Uninstalling Exponent from Android device.');
  return await _getAdbOutputAsync(['uninstall', 'host.exp.exponent']);
}

export async function upgradeExponentAsync() {
  try {
    if (!(await _assertDeviceReadyAsync())) {
      return;
    }

    await _uninstallExponentAsync();
    await _installExponentAsync();

    if (_lastUrl) {
      Logger.global.info(`Opening ${_lastUrl} in Exponent.`);
      await _getAdbOutputAsync(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', _lastUrl]);
      _lastUrl = null;
    }
  } catch (e) {
    Logger.global.error(e.message);
  }
}

// Open Url
async function _assertDeviceReadyAsync() {
  const genymotionMessage = `https://developer.android.com/studio/run/device.html#developer-device-options. If you are using Genymotion go to Settings -> ADB, select "Use custom Android SDK tools", and point it at your Android SDK directory.`;

  if (!(await _isDeviceAttachedAsync())) {
    throw new Error(`No Android device found. Please connect a device and follow the instructions here to enable USB debugging:\n${genymotionMessage}`);
  }

  if (!(await _isDeviceAuthorizedAsync())) {
    throw new Error(`This computer is not authorized to debug the device. Please follow the instructions here to enable USB debugging:\n${genymotionMessage}`);
  }
}

async function _openUrlAsync(url: string) {
  let output = await _getAdbOutputAsync(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url]);
  if (output.includes(CANT_START_ACTIVITY_ERROR)) {
    throw new Error(output.substring(output.indexOf('Error: ')));
  }

  return output;
}

async function openUrlAsync(url: string, isDetached: boolean = false) {
  try {
    if (!(await _assertDeviceReadyAsync())) {
      return;
    }

    let installedExponent = false;
    if (!isDetached && !(await _isExponentInstalledAsync())) {
      await _installExponentAsync();
      installedExponent = true;
    }

    if (!isDetached) {
      _lastUrl = url;
      _checkExponentUpToDateAsync(); // let this run in background
    }

    Logger.global.info(`Opening on Android device`);
    try {
      await _openUrlAsync(url);
    } catch (e) {
      if (isDetached) {
        e.message = `Error running app. Have you installed the app already using Android Studio? Since you are detached you must build manually. ${e.message}`;
      } else {
        e.message = `Error running app. ${e.message}`;
      }

      throw e;
    }

    Analytics.logEvent('Open Url on Device', {
      platform: 'android',
      installedExponent,
    });
  } catch (e) {
    e.message = `Error running adb: ${e.message}`;
    throw e;
  }
}

export async function openProjectAsync(projectRoot: string) {
  try {
    await startAdbReverseAsync(projectRoot);

    let projectUrl = await UrlUtils.constructManifestUrlAsync(projectRoot);
    let { exp } = await ProjectUtils.readConfigJsonAsync(projectRoot);

    await openUrlAsync(projectUrl, !!exp.isDetached);
    return { success: true, error: null };
  } catch (e) {
    Logger.global.error(`Couldn't start project on Android: ${e.message}`);
    return { success: false, error: e };
  }
}

// Adb reverse
export async function startAdbReverseAsync(projectRoot: string) {
  let packagerInfo = await ProjectSettings.readPackagerInfoAsync(projectRoot);
  return await adbReverse(packagerInfo.packagerPort) && await adbReverse(packagerInfo.exponentServerPort);
}

export async function stopAdbReverseAsync(projectRoot: string) {
  let packagerInfo = await ProjectSettings.readPackagerInfoAsync(projectRoot);
  await adbReverseRemove(packagerInfo.packagerPort);
  await adbReverseRemove(packagerInfo.exponentServerPort);
}

async function adbReverse(port: number) {
  if (!await _isDeviceAuthorizedAsync()) {
    return false;
  }

  try {
    await _getAdbOutputAsync(['reverse', `tcp:${port}`, `tcp:${port}`]);
    return true;
  } catch (e) {
    Logger.global.warn(`Couldn't adb reverse: ${e.message}`);
    return false;
  }
}

async function adbReverseRemove(port: number) {
  if (!await _isDeviceAuthorizedAsync()) {
    return false;
  }

  try {
    await _getAdbOutputAsync(['reverse', '--remove', `tcp:${port}`]);
    return true;
  } catch (e) {
    // Don't send this to warn because we call this preemptively sometimes
    Logger.global.debug(`Couldn't adb reverse remove: ${e.message}`);
    return false;
  }
}
