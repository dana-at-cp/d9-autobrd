// Copyright 2020 Dana James Traversie, Check Point Software Technologies, Ltd.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

const { v4: uuidv4 } = require('uuid');
const auth = require('./lib/auth');
const dome9 = require('./lib/dome9');
const gcp = require('./lib/gcp');

/**
 * Onboards supported cloud accounts to Check Point CloudGuard CSPM a.k.a. Dome9.
 * @param {Express.Request} req The API request.
 * @param {Express.Response} res The API response.
 */
exports.d9AutobrdOnboard = async (req, res) => {
  var execId = uuidv4();
  console.log("d9-autobrd execution started", execId);
  var timeLabel = "d9-autobrd execution finished " + execId;
  console.time(timeLabel);
  var jsonResp = { 'exec_id': execId };
  try {
    var gcpIsGo = false;
    switch (req.method) {
      case 'GET':
        if (auth.check(req.query.psk)) {
          gcpIsGo = true;
        } else {
          res.status(401);
          console.error('Authentication failure');
        }
        break;
      case 'POST':
        if (auth.check(req.body.psk)) {
          gcpIsGo = true;
        } else {
          res.status(401);
          console.error('Authentication failure');
        }
        break;
      default:
        res.status(405);
        jsonResp['error'] = 'true';
        break;
    }
    if (gcpIsGo) {
      await onboardGoogleProjects();
    }
  } catch (e) {
    res.status(500);
    jsonResp['error'] = 'true';
    console.error(e);
  }
  console.timeEnd(timeLabel);
  res.send(jsonResp);
};

const onboardGoogleProjects = async () => {
  var cloudAccountsMap = await dome9.getGoogleCloudAccountsMap();
  var projects = await gcp.listProjects();
  for (let p of projects) {
    if (clearToBoard(p, cloudAccountsMap)) {
      if (await gcp.enableRequiredAPIServices(p['projectId'])) {
        console.log(p['projectId'], "=>", "Enabled all required API services in project");
      }
      var serviceAccount = await gcp.getCloudGuardServiceAccount(p['projectId']);
      if (!serviceAccount['email']) {
        var saNew = await gcp.createServiceAccount(p['projectId']);
        console.log(p['projectId'], "=>", "Created 'CloudGuard-Connect' service account");
        if (saNew['email']) {
          await gcp.updateProjectIAMPolicy(p, saNew);
        }
      } else {
        await gcp.deleteServiceAccountKeys(p['projectId'], serviceAccount['email']);
        console.log(p['projectId'], "=>", "Deleted all 'CloudGuard-Connect' service account keys");
        var saKey = await gcp.createServiceAccountKey(p['projectId'], serviceAccount['email']);
        console.log(p['projectId'], "=>", "Created new 'CloudGuard-Connect' service account key");
        var saPrivateKeyData = Buffer.from(saKey['privateKeyData'], 'base64').toString();
        var r = await dome9.createGoogleCloudAccount(p['name'], JSON.parse(saPrivateKeyData));
        if (r.id) {
          console.log(p['projectId'], "=>", "Project was onboarded successfully");
        }
      }
    }
  }
};

const clearToBoard = (project, cloudAccountsMap) => {
  var result = false;
  const projectId = project['projectId'];
  const lifecycleState = project['lifecycleState'];
  const projectInDome9 = isProjectInDome9(project, cloudAccountsMap);
  if (projectInDome9) {
    console.log(projectId, "=>", "Project was already onboarded");
  }
  if (lifecycleState != 'ACTIVE') {
    console.log(projectId, "=>", `Project in unsupported state '{$lifecycleState}'`);
  } else if (project['labels']) {
    if (project['labels']['dome9-ignore'] == "true") {
      console.log(projectId, "=>", "Project has the 'dome9-ignore' label set to true");
    }
  } else {
    result = !projectInDome9;
  }
  return result;
};

const isProjectInDome9 = (project, cloudAccountsMap) => {
  return cloudAccountsMap.has(project.projectId);
};