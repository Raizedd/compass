const { expect } = require('chai');
const Enzyme = require('enzyme');
const Adapter = require('enzyme-adapter-react-16');
const jsdomGlobal = require('jsdom-global');
const m = require('module');
const React = require('react');
const debug = require('debug')('connectivity-test');
const { promisify } = require('util');

Enzyme.configure({ adapter: new Adapter() });
const { mount } = Enzyme;

// Stub electron module for tests
const originalLoader = m._load;
const stubs = {
  electron: {
    ipcMain: {
      call: (methodName) => {
        debug('electron.ipcMain.call main called!', methodName);
      },
      respondTo: (methodName) => {
        debug('electron.ipcMain.respondTo main called!', methodName);
      },
      on: (methodName) => {
        debug('electron.ipcMain.on main called!', methodName);
      }
    },
    remote: {
      app: {
        getName: () => 'Compass Connectivity Integration Test Suite',
        getPath: () => ''
      },
      dialog: {
        remote: {},
        BrowserWindow: {}
      }
    },
    shell: {}
  }
};
m._load = function hookedLoader(request, parent, isMain) {
  const stub = stubs[request];
  return stub || originalLoader(request, parent, isMain);
};

// Mock dom/window for tests.
// Has to come before @mongodb-js/compass-connect require.
jsdomGlobal();

const AppRegistry = require('hadron-app-registry');
const Connection = require('mongodb-connection-model');
const CompassConnectPlugin = require('@mongodb-js/compass-connect');
const CompassConnectComponent = CompassConnectPlugin.default;
const activateCompassConnect = CompassConnectPlugin.activate;

const deactivateCompassConnect = CompassConnectPlugin.deactivate;

const TEST_TIMEOUT_MS = require('./.mocharc.json').timeout;
const {
  dockerComposeDown,
  dockerComposeUp
} = require('./docker-instance-manager');

// Hide react warnings.
const originalWarn = console.warn.bind(console.warn);
console.warn = (msg) => (
  !msg.toString().includes('componentWillReceiveProps')
  && !msg.toString().includes('componentWillUpdate')
  && originalWarn(msg)
);

const delay = promisify(setTimeout);
const ensureConnected = async(timeout, testIsConnected) => {
  let connected = await testIsConnected();
  let timespentTesting = 0;
  while (!connected) {
    if (timeout > TEST_TIMEOUT_MS || timespentTesting > TEST_TIMEOUT_MS) {
      throw new Error('Waited for connection, never happened');
    }
    debug(`Testing connectivity at timeout=${timeout}, connected=${connected}`);
    await delay(timeout);
    timespentTesting += timeout;
    timeout *= 2; // Try again but wait double.
    connected = await testIsConnected();
  }
  return connected;
};

const connectionsToTest = [{
  title: 'local community standalone',
  dockerComposeFilePath: 'community/docker-compose.yaml',
  model: {
    hostname: 'localhost',
    port: 27020,
  },
  expectedInstanceDetails: {
    _id: 'localhost:27020',
    hostname: 'localhost',
    port: 27020,
    client: {
      isWritable: true,
      isMongos: false,
    },
    build: {
      raw: {
        version: /4.4.[1-9]+$/
      }
    },
    host: {
      os: 'Ubuntu',
      os_family: 'linux',
      kernel_version: '18.04',
      arch: 'x86_64'
    },
    genuineMongoDB: { isGenuine: true, dbType: 'mongodb' },
    dataLake: { isDataLake: false, version: null },
  }
}];

describe('Connectivity', () => {
  let appRegistry;
  let compassConnectStore;
  connectionsToTest.forEach(connection => {
    before(() => {
      dockerComposeUp(connection.dockerComposeFilePath);

      appRegistry = new AppRegistry();

      activateCompassConnect(appRegistry);

      global.hadronApp = {
        appRegistry
      };

      const ROLE = {
        name: 'Status',
        component: () => (<div id="statusPlugin">Status</div>)
      };
      global.hadronApp.appRegistry = appRegistry;
      global.hadronApp.appRegistry.registerRole('Application.Status', ROLE);

      compassConnectStore = appRegistry.getStore('Connect.Store');

      // Remove all logic around saving and loading stored connections.
      // NOTE: This is tightly coupled with the store in compass-connect.
      // https://github.com/mongodb-js/compass-connect/blob/master/src/stores/index.js
      compassConnectStore._saveRecent = () => {};
      compassConnectStore._saveConnection = () => {};
      compassConnectStore.state.fetchedConnections = [];
      compassConnectStore.StatusActions = {
        done: () => {},
        showIndeterminateProgressBar: () => {}
      };
      compassConnectStore.appRegistry = appRegistry;
    });

    after(() => {
      deactivateCompassConnect(appRegistry);

      dockerComposeDown(connection.dockerComposeFilePath);
    });

    context(`Connection ${connection.title} can connect`, () => {
      it('loads connection, connects, and loads instance information', async() => {
        // 1. Load the connection into our connection model.
        const model = new Connection(connection.model);
        debug('Created model with connection string:', model.driverUrl);

        // 2. Load the connection model through compass-connect and render it.
        // Load the connection into compass-connect's connection model.
        compassConnectStore.state.currentConnection = model;
        compassConnectStore.trigger(compassConnectStore.state);

        // Here we use the parsed connection model and build a url.
        // This is something that would occur if
        // a user is switching between the connection views and editing.
        compassConnectStore.state.customUrl = compassConnectStore.state.currentConnection.driverUrlWithSsh;
        compassConnectStore.trigger(compassConnectStore.state);

        const wrapper = mount(<CompassConnectComponent />);

        // Ensures the model doesn't cause any errors when rendering.
        await compassConnectStore.validateConnectionString();

        expect(compassConnectStore.state.errorMessage).to.equal(null);
        expect(compassConnectStore.state.syntaxErrorMessage).to.equal(null);
        expect(compassConnectStore.state.isValid).to.equal(true);

        let timesConnectedCalled = 0;
        let dataServiceConnected = false;
        let dataServiceConnectedErr;
        appRegistry.on('data-service-connected', (err) => {
          timesConnectedCalled++;
          dataServiceConnected = true;
          dataServiceConnectedErr = err;
        });

        // Simulate clicking connect.
        wrapper.find('button[name="connect"]').simulate('click');

        expect(compassConnectStore.state.errorMessage).to.equal(null);
        expect(compassConnectStore.state.syntaxErrorMessage).to.equal(null);
        expect(compassConnectStore.state.isValid).to.equal(true);

        // 3. Wait for the connection event to occur.
        await ensureConnected(100, () => dataServiceConnected);

        if (dataServiceConnectedErr) {
          throw dataServiceConnectedErr;
        }

        if (timesConnectedCalled > 1) {
          throw new Error('data-service-connected called multiple times');
        }

        const dataService = compassConnectStore.dataService;

        // 4. Fetch the instance details using the new connection.
        const runFetchInstanceDetails = promisify(dataService.instance.bind(dataService));
        const instanceDetails = await runFetchInstanceDetails({});

        const runDisconnect = promisify(dataService.disconnect.bind(dataService));
        await runDisconnect();

        // 5. Ensure the connection details are what we expect.
        const expectedInstanceDetails = connection.expectedInstanceDetails;
        expect(instanceDetails._id).to.equal(
          expectedInstanceDetails._id
        );
        Object.keys(expectedInstanceDetails.host).forEach(hostDetailKey => {
          expect(instanceDetails.host[hostDetailKey]).to.equal(
            expectedInstanceDetails.host[hostDetailKey]
          );
        });
        expect(instanceDetails.build.raw.version.match(
          expectedInstanceDetails.build.raw.version
        ).length).to.equal(1);
        expect(instanceDetails.client.isWritable).to.equal(
          expectedInstanceDetails.client.isWritable
        );
        expect(instanceDetails.client.isMongos).to.equal(
          expectedInstanceDetails.client.isMongos
        );
        expect(instanceDetails.dataLake).to.deep.equal(
          expectedInstanceDetails.dataLake
        );
        expect(instanceDetails.genuineMongoDB).to.deep.equal(
          expectedInstanceDetails.genuineMongoDB
        );
        expect(instanceDetails.hostname).to.equal(
          expectedInstanceDetails.hostname
        );
        expect(instanceDetails.port).to.equal(
          expectedInstanceDetails.port
        );
      });
    });
  });
});
