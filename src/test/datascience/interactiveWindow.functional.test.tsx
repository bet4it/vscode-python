// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import * as assert from 'assert';
import * as fs from 'fs-extra';
import { parse } from 'node-html-parser';
import * as os from 'os';
import * as path from 'path';
import * as TypeMoq from 'typemoq';
import { Disposable, Selection, TextDocument, TextEditor } from 'vscode';

import { IApplicationShell, IDocumentManager } from '../../client/common/application/types';
import { createDeferred, waitForPromise } from '../../client/common/utils/async';
import { noop } from '../../client/common/utils/misc';
import { generateCellsFromDocument } from '../../client/datascience/cellFactory';
import { concatMultilineString } from '../../client/datascience/common';
import { EditorContexts } from '../../client/datascience/constants';
import { InteractiveWindow } from '../../client/datascience/interactive-window/interactiveWindow';
import {
    InteractiveWindowMessageListener
} from '../../client/datascience/interactive-window/interactiveWindowMessageListener';
import { InteractiveWindowMessages } from '../../client/datascience/interactive-window/interactiveWindowTypes';
import { IInteractiveWindow, IInteractiveWindowProvider } from '../../client/datascience/types';
import { MainPanel } from '../../datascience-ui/history-react/MainPanel';
import { ImageButton } from '../../datascience-ui/react-common/imageButton';
import { DataScienceIocContainer } from './dataScienceIocContainer';
import { createDocument } from './editor-integration/helpers';
import {
    addCode,
    addContinuousMockData,
    addMockData,
    CellInputState,
    CellPosition,
    defaultDataScienceSettings,
    enterInput,
    escapePath,
    findButton,
    getCellResults,
    getLastOutputCell,
    initialDataScienceSettings,
    runMountedTest,
    srcDirectory,
    toggleCellExpansion,
    updateDataScienceSettings,
    verifyHtmlOnCell,
    verifyLastCellInputState
} from './interactiveWindowTestHelpers';
import { MockDocumentManager } from './mockDocumentManager';
import { MockEditor } from './mockTextEditor';
import { waitForUpdate } from './reactHelpers';

//import { asyncDump } from '../common/asyncDump';
// tslint:disable:max-func-body-length trailing-comma no-any no-multiline-string
suite('DataScience Interactive Window output tests', () => {
    const disposables: Disposable[] = [];
    let ioc: DataScienceIocContainer;

    setup(() => {
        ioc = new DataScienceIocContainer();
        ioc.registerDataScienceTypes();
    });

    teardown(async () => {
        for (const disposable of disposables) {
            if (!disposable) {
                continue;
            }
            // tslint:disable-next-line:no-any
            const promise = disposable.dispose() as Promise<any>;
            if (promise) {
                await promise;
            }
        }
        await ioc.dispose();
    });

    // Uncomment this to debug hangs on exit
    // suiteTeardown(() => {
    //      asyncDump();
    // });

    async function getOrCreateInteractiveWindow(): Promise<IInteractiveWindow> {
        const interactiveWindowProvider = ioc.get<IInteractiveWindowProvider>(IInteractiveWindowProvider);
        const result = await interactiveWindowProvider.getOrCreateActive();

        // During testing the MainPanel sends the init message before our interactive window is created.
        // Pretend like it's happening now
        const listener = ((result as any).messageListener) as InteractiveWindowMessageListener;
        listener.onMessage(InteractiveWindowMessages.Started, {});

        return result;
    }

    async function waitForMessageResponse(action: () => void): Promise<void> {
        ioc.wrapperCreatedPromise  = createDeferred<boolean>();
        action();
        await ioc.wrapperCreatedPromise.promise;
        ioc.wrapperCreatedPromise = undefined;
    }

    runMountedTest('Simple text', async (wrapper) => {
        await addCode(getOrCreateInteractiveWindow, wrapper, 'a=1\na');

        verifyHtmlOnCell(wrapper, '<span>1</span>', CellPosition.Last);
    }, () => { return ioc; });

    runMountedTest('Hide inputs', async (wrapper) => {
        initialDataScienceSettings({ ...defaultDataScienceSettings(), showCellInputCode: false });

        await addCode(getOrCreateInteractiveWindow, wrapper, 'a=1\na');

        verifyLastCellInputState(wrapper, CellInputState.Hidden);

        // Add a cell without output, this cell should not show up at all
        addMockData(ioc, 'a=1', undefined, 'text/plain');
        await addCode(getOrCreateInteractiveWindow, wrapper, 'a=1', 4);

        verifyHtmlOnCell(wrapper, '<span>1</span>', CellPosition.First);
        verifyHtmlOnCell(wrapper, undefined, CellPosition.Last);
    }, () => { return ioc; });

    runMountedTest('Show inputs', async (wrapper) => {
        initialDataScienceSettings({ ...defaultDataScienceSettings() });

        await addCode(getOrCreateInteractiveWindow, wrapper, 'a=1\na');

        verifyLastCellInputState(wrapper, CellInputState.Visible);
        verifyLastCellInputState(wrapper, CellInputState.Collapsed);
    }, () => { return ioc; });

    runMountedTest('Expand inputs', async (wrapper) => {
        initialDataScienceSettings({ ...defaultDataScienceSettings(), collapseCellInputCodeByDefault: false });
        await addCode(getOrCreateInteractiveWindow, wrapper, 'a=1\na');

        verifyLastCellInputState(wrapper, CellInputState.Expanded);
    }, () => { return ioc; });

    runMountedTest('Collapse / expand cell', async (wrapper) => {
        initialDataScienceSettings({ ...defaultDataScienceSettings() });
        await addCode(getOrCreateInteractiveWindow, wrapper, 'a=1\na');

        verifyLastCellInputState(wrapper, CellInputState.Visible);
        verifyLastCellInputState(wrapper, CellInputState.Collapsed);

        toggleCellExpansion(wrapper);

        verifyLastCellInputState(wrapper, CellInputState.Visible);
        verifyLastCellInputState(wrapper, CellInputState.Expanded);

        toggleCellExpansion(wrapper);

        verifyLastCellInputState(wrapper, CellInputState.Visible);
        verifyLastCellInputState(wrapper, CellInputState.Collapsed);
    }, () => { return ioc; });

    runMountedTest('Hide / show cell', async (wrapper) => {
        initialDataScienceSettings({ ...defaultDataScienceSettings() });
        await addCode(getOrCreateInteractiveWindow, wrapper, 'a=1\na');

        verifyLastCellInputState(wrapper, CellInputState.Visible);
        verifyLastCellInputState(wrapper, CellInputState.Collapsed);

        // Hide the inputs and verify
        updateDataScienceSettings(wrapper, { ...defaultDataScienceSettings(), showCellInputCode: false });

        verifyLastCellInputState(wrapper, CellInputState.Hidden);

        // Show the inputs and verify
        updateDataScienceSettings(wrapper, { ...defaultDataScienceSettings(), showCellInputCode: true });

        verifyLastCellInputState(wrapper, CellInputState.Visible);
        verifyLastCellInputState(wrapper, CellInputState.Collapsed);
    }, () => { return ioc; });

    runMountedTest('Mime Types', async (wrapper) => {
        const badPanda = `import pandas as pd
df = pd.read("${escapePath(path.join(srcDirectory(), 'DefaultSalesReport.csv'))}")
df.head()`;
        const goodPanda = `import pandas as pd
df = pd.read_csv("${escapePath(path.join(srcDirectory(), 'DefaultSalesReport.csv'))}")
df.head()`;
        const matPlotLib = 'import matplotlib.pyplot as plt\r\nimport numpy as np\r\nx = np.linspace(0,20,100)\r\nplt.plot(x, np.sin(x))\r\nplt.show()';
        const matPlotLibResults = 'svg';
        const spinningCursor = `import sys
import time

def spinning_cursor():
    while True:
        for cursor in '|/-\\\\':
            yield cursor

spinner = spinning_cursor()
for _ in range(50):
    sys.stdout.write(next(spinner))
    sys.stdout.flush()
    time.sleep(0.1)
    sys.stdout.write('\\r')`;

        addMockData(ioc, badPanda, `pandas has no attribute 'read'`, 'text/html', 'error');
        addMockData(ioc, goodPanda, `<td>A table</td>`, 'text/html');
        addMockData(ioc, matPlotLib, matPlotLibResults, 'text/html');
        const cursors = ['|', '/', '-', '\\'];
        let cursorPos = 0;
        let loops = 3;
        addContinuousMockData(ioc, spinningCursor, async (_c) => {
            const result = `${cursors[cursorPos]}\r`;
            cursorPos += 1;
            if (cursorPos >= cursors.length) {
                cursorPos = 0;
                loops -= 1;
            }
            return Promise.resolve({ result: result, haveMore: loops > 0 });
        });

        await addCode(getOrCreateInteractiveWindow, wrapper, badPanda, 4);
        verifyHtmlOnCell(wrapper, `has no attribute 'read'`, CellPosition.Last);

        await addCode(getOrCreateInteractiveWindow, wrapper, goodPanda);
        verifyHtmlOnCell(wrapper, `<td>`, CellPosition.Last);

        await addCode(getOrCreateInteractiveWindow, wrapper, matPlotLib);
        verifyHtmlOnCell(wrapper, matPlotLibResults, CellPosition.Last);

        await addCode(getOrCreateInteractiveWindow, wrapper, spinningCursor, 4 + (ioc.mockJupyter ? (cursors.length * 3) : 0));
        verifyHtmlOnCell(wrapper, '<div>', CellPosition.Last);
    }, () => { return ioc; });

    runMountedTest('Undo/redo commands', async (wrapper) => {
        const interactiveWindow = await getOrCreateInteractiveWindow();

        // Get a cell into the list
        await addCode(getOrCreateInteractiveWindow, wrapper, 'a=1\na');

        // Now verify if we undo, we have no cells
        let afterUndo = await getCellResults(wrapper, 1, () => {
            interactiveWindow.undoCells();
            return Promise.resolve();
        });

        assert.equal(afterUndo.length, 1, `Undo should remove cells + ${afterUndo.debug()}`);

        // Redo should put the cells back
        const afterRedo = await getCellResults(wrapper, 1, () => {
            interactiveWindow.redoCells();
            return Promise.resolve();
        });
        assert.equal(afterRedo.length, 2, 'Redo should put cells back');

        // Get another cell into the list
        const afterAdd = await addCode(getOrCreateInteractiveWindow, wrapper, 'a=1\na');
        assert.equal(afterAdd.length, 3, 'Second cell did not get added');

        // Clear everything
        const afterClear = await getCellResults(wrapper, 1, () => {
            interactiveWindow.removeAllCells();
            return Promise.resolve();
        });
        assert.equal(afterClear.length, 1, 'Clear didn\'t work');

        // Undo should put them back
        afterUndo = await getCellResults(wrapper, 1, () => {
            interactiveWindow.undoCells();
            return Promise.resolve();
        });

        assert.equal(afterUndo.length, 3, `Undo should put cells back`);
    }, () => { return ioc; });

    runMountedTest('Click buttons', async (wrapper) => {
        // Goto source should cause the visible editor to be picked as long as its filename matches
        const showedEditor = createDeferred();
        const textEditors: TextEditor[] = [];
        const docManager = TypeMoq.Mock.ofType<IDocumentManager>();
        const visibleEditor = TypeMoq.Mock.ofType<TextEditor>();
        const dummyDocument = TypeMoq.Mock.ofType<TextDocument>();
        dummyDocument.setup(d => d.fileName).returns(() => 'foo.py');
        visibleEditor.setup(v => v.show()).returns(() => showedEditor.resolve());
        visibleEditor.setup(v => v.revealRange(TypeMoq.It.isAny())).returns(noop);
        visibleEditor.setup(v => v.document).returns(() => dummyDocument.object);
        textEditors.push(visibleEditor.object);
        docManager.setup(a => a.visibleTextEditors).returns(() => textEditors);
        ioc.serviceManager.rebindInstance<IDocumentManager>(IDocumentManager, docManager.object);

        // Get a cell into the list
        await addCode(getOrCreateInteractiveWindow, wrapper, 'a=1\na');

        // 'Click' the buttons in the react control
        const undo = findButton(wrapper, 2);
        const redo = findButton(wrapper, 1);
        const clear = findButton(wrapper, 0);

        // Now verify if we undo, we have no cells
        let afterUndo = await getCellResults(wrapper, 1, () => {
            undo!.simulate('click');
            return Promise.resolve();
        });

        assert.equal(afterUndo.length, 1, `Undo should remove cells + ${afterUndo.debug()}`);

        // Redo should put the cells back
        const afterRedo = await getCellResults(wrapper, 1, async () => {
            redo!.simulate('click');
            return Promise.resolve();
        });
        assert.equal(afterRedo.length, 2, 'Redo should put cells back');

        // Get another cell into the list
        const afterAdd = await addCode(getOrCreateInteractiveWindow, wrapper, 'a=1\na');
        assert.equal(afterAdd.length, 3, 'Second cell did not get added');

        // Clear everything
        const afterClear = await getCellResults(wrapper, 1, async () => {
            clear!.simulate('click');
            return Promise.resolve();
        });
        assert.equal(afterClear.length, 1, 'Clear didn\'t work');

        // Undo should put them back
        afterUndo = await getCellResults(wrapper, 1, async () => {
            undo!.simulate('click');
            return Promise.resolve();
        });

        assert.equal(afterUndo.length, 3, `Undo should put cells back`);

        // find the buttons on the cell itself
        const ImageButtons = afterUndo.at(afterUndo.length - 2).find(ImageButton);
        assert.equal(ImageButtons.length, 3, 'Cell buttons not found');
        const goto = ImageButtons.at(0);
        const deleteButton = ImageButtons.at(2);

        // Make sure goto works
        await waitForMessageResponse(() => goto.simulate('click'));
        await waitForPromise(showedEditor.promise, 1000);
        assert.ok(showedEditor.resolved, 'Goto source is not jumping to editor');

        // Make sure delete works
        const afterDelete = await getCellResults(wrapper, 1, async () => {
            deleteButton.simulate('click');
            return Promise.resolve();
        });
        assert.equal(afterDelete.length, 2, `Delete should remove a cell`);
    }, () => { return ioc; });

    runMountedTest('Export', async (wrapper) => {
        // Export should cause the export dialog to come up. Remap appshell so we can check
        const dummyDisposable = {
            dispose: () => { return; }
        };
        let exportCalled = false;
        const appShell = TypeMoq.Mock.ofType<IApplicationShell>();
        appShell.setup(a => a.showErrorMessage(TypeMoq.It.isAnyString())).returns((e) => { throw e; });
        appShell.setup(a => a.showInformationMessage(TypeMoq.It.isAny(), TypeMoq.It.isAny())).returns(() => Promise.resolve(''));
        appShell.setup(a => a.showSaveDialog(TypeMoq.It.isAny())).returns(() => {
            exportCalled = true;
            return Promise.resolve(undefined);
        });
        appShell.setup(a => a.setStatusBarMessage(TypeMoq.It.isAny())).returns(() => dummyDisposable);
        ioc.serviceManager.rebindInstance<IApplicationShell>(IApplicationShell, appShell.object);

        // Make sure to create the interactive window after the rebind or it gets the wrong application shell.
        await addCode(getOrCreateInteractiveWindow, wrapper, 'a=1\na');
        const interactiveWindow = await getOrCreateInteractiveWindow();

        // Export should cause exportCalled to change to true
        await waitForMessageResponse(() => interactiveWindow.exportCells());
        assert.equal(exportCalled, true, 'Export is not being called during export');

        // Remove the cell
        const exportButton = findButton(wrapper, 5);
        const undo = findButton(wrapper, 2);

        // Now verify if we undo, we have no cells
        const afterUndo = await getCellResults(wrapper, 1, () => {
            undo!.simulate('click');
            return Promise.resolve();
        });

        assert.equal(afterUndo.length, 1, 'Undo should remove cells');

        // Then verify we cannot click the button (it should be disabled)
        exportCalled = false;
        const response = waitForMessageResponse(() => exportButton!.simulate('click'));
        await waitForPromise(response, 100);
        assert.equal(exportCalled, false, 'Export should not be called when no cells visible');

    }, () => { return ioc; });

    runMountedTest('Dispose test', async () => {
        // tslint:disable-next-line:no-any
        const interactiveWindow = await getOrCreateInteractiveWindow();
        await interactiveWindow.show(); // Have to wait for the load to finish
        await interactiveWindow.dispose();
        // tslint:disable-next-line:no-any
        const h2 = await getOrCreateInteractiveWindow();
        // Check equal and then dispose so the test goes away
        const equal = Object.is(interactiveWindow, h2);
        await h2.show();
        assert.ok(!equal, 'Disposing is not removing the active interactive window');
    }, () => { return ioc; });

    runMountedTest('Editor Context', async (wrapper) => {
        // Verify we can send different commands to the UI and it will respond
        const interactiveWindow = await getOrCreateInteractiveWindow();

        // Before we have any cells, verify our contexts are not set
        assert.equal(ioc.getContext(EditorContexts.HaveInteractive), false, 'Should not have interactive before starting');
        assert.equal(ioc.getContext(EditorContexts.HaveInteractiveCells), false, 'Should not have interactive cells before starting');
        assert.equal(ioc.getContext(EditorContexts.HaveRedoableCells), false, 'Should not have redoable before starting');

        // Get an update promise so we can wait for the add code
        const updatePromise = waitForUpdate(wrapper, MainPanel);

        // Send some code to the interactive window
        await interactiveWindow.addCode('a=1\na', 'foo.py', 2);

        // Wait for the render to go through
        await updatePromise;

        // Now we should have the 3 editor contexts
        assert.equal(ioc.getContext(EditorContexts.HaveInteractive), true, 'Should have interactive after starting');
        assert.equal(ioc.getContext(EditorContexts.HaveInteractiveCells), true, 'Should have interactive cells after starting');
        assert.equal(ioc.getContext(EditorContexts.HaveRedoableCells), false, 'Should not have redoable after starting');

        // Setup a listener for context change events. We have 3 separate contexts, so we have to wait for all 3.
        let count = 0;
        let deferred = createDeferred<boolean>();
        const eventDispose = ioc.onContextSet(_a => {
            count += 1;
            if (count >= 3) {
                deferred.resolve();
            }
        });
        disposables.push(eventDispose);

        // Create a method that resets the waiting
        const resetWaiting = () => {
            count = 0;
            deferred = createDeferred<boolean>();
        };

        // Now send an undo command. This should change the state, so use our waitForInfo promise instead
        resetWaiting();
        interactiveWindow.undoCells();
        await waitForPromise(deferred.promise, 2000);
        assert.ok(deferred.resolved, 'Never got update to state');
        assert.equal(ioc.getContext(EditorContexts.HaveInteractiveCells), false, 'Should not have interactive cells after undo as sysinfo is ignored');
        assert.equal(ioc.getContext(EditorContexts.HaveRedoableCells), true, 'Should have redoable after undo');

        resetWaiting();
        interactiveWindow.redoCells();
        await waitForPromise(deferred.promise, 2000);
        assert.ok(deferred.resolved, 'Never got update to state');
        assert.equal(ioc.getContext(EditorContexts.HaveInteractiveCells), true, 'Should have interactive cells after redo');
        assert.equal(ioc.getContext(EditorContexts.HaveRedoableCells), false, 'Should not have redoable after redo');

        resetWaiting();
        interactiveWindow.removeAllCells();
        await waitForPromise(deferred.promise, 2000);
        assert.ok(deferred.resolved, 'Never got update to state');
        assert.equal(ioc.getContext(EditorContexts.HaveInteractiveCells), false, 'Should not have interactive cells after delete');
    }, () => { return ioc; });

    runMountedTest('Simple input', async (wrapper) => {
        // Create an interactive window so that it listens to the results.
        const interactiveWindow = await getOrCreateInteractiveWindow();
        await interactiveWindow.show();

        // Then enter some code.
        await enterInput(wrapper, 'a=1\na');
        verifyHtmlOnCell(wrapper, '<span>1</span>', CellPosition.Last);
    }, () => { return ioc; });

    runMountedTest('Copy to source input', async (wrapper) => {
        const showedEditor = createDeferred();
        ioc.addDocument('# No cells here', 'foo.py');
        const docManager = ioc.get<IDocumentManager>(IDocumentManager) as MockDocumentManager;
        const editor = await docManager.showTextDocument(docManager.textDocuments[0]) as MockEditor;
        editor.setRevealCallback(() => showedEditor.resolve());

        // Create an interactive window so that it listens to the results.
        const interactiveWindow = await getOrCreateInteractiveWindow();
        await interactiveWindow.show();

        // Then enter some code.
        await enterInput(wrapper, 'a=1\na');
        verifyHtmlOnCell(wrapper, '<span>1</span>', CellPosition.Last);
        const ImageButtons = getLastOutputCell(wrapper).find(ImageButton);
        assert.equal(ImageButtons.length, 3, 'Cell buttons not found');
        const copyToSource = ImageButtons.at(1);

        // Then click the copy to source button
        await waitForMessageResponse(() => copyToSource.simulate('click'));
        await waitForPromise(showedEditor.promise, 100);
        assert.ok(showedEditor.resolved, 'Copy to source is not adding code to the editor');

    }, () => { return ioc; });

    runMountedTest('Multiple input', async (wrapper) => {
        // Create an interactive window so that it listens to the results.
        const interactiveWindow = await getOrCreateInteractiveWindow();
        await interactiveWindow.show();

        // Then enter some code.
        await enterInput(wrapper, 'a=1\na');
        verifyHtmlOnCell(wrapper, '<span>1</span>', CellPosition.Last);

        // Then delete the node
        const lastCell = getLastOutputCell(wrapper);
        const ImageButtons = lastCell.find(ImageButton);
        assert.equal(ImageButtons.length, 3, 'Cell buttons not found');
        const deleteButton = ImageButtons.at(2);

        // Make sure delete works
        const afterDelete = await getCellResults(wrapper, 1, async () => {
            deleteButton.simulate('click');
            return Promise.resolve();
        });
        assert.equal(afterDelete.length, 1, `Delete should remove a cell`);

        // Should be able to enter again
        await enterInput(wrapper, 'a=1\na');
        verifyHtmlOnCell(wrapper, '<span>1</span>', CellPosition.Last);

        // Try a 3rd time with some new input
        addMockData(ioc, 'print("hello")', 'hello');
        await enterInput(wrapper, 'print("hello")');
        verifyHtmlOnCell(wrapper, '>hello</', CellPosition.Last);
    }, () => { return ioc; });

    runMountedTest('Restart with session failure', async (wrapper) => {
        // Prime the pump
        await addCode(getOrCreateInteractiveWindow, wrapper, 'a=1\na');
        verifyHtmlOnCell(wrapper, '<span>1</span>', CellPosition.Last);

        // Then something that could possibly timeout
        addContinuousMockData(ioc, 'import time\r\ntime.sleep(1000)', (_c) => {
            return Promise.resolve({ result: '', haveMore: true});
        });

        // Then get our mock session and force it to not restart ever.
        if (ioc.mockJupyter) {
            const currentSession = ioc.mockJupyter.getCurrentSession();
            if (currentSession) {
                currentSession.prolongRestarts();
            }
        }

        // Then try executing our long running cell and restarting in the middle
        const interactiveWindow = await getOrCreateInteractiveWindow();
        const executed = createDeferred();
        // We have to wait until the execute goes through before we reset.
        interactiveWindow.onExecutedCode(() => executed.resolve());
        const added = interactiveWindow.addCode('import time\r\ntime.sleep(1000)', 'foo', 0);
        await executed.promise;
        await interactiveWindow.restartKernel();
        await added;

        // Now see if our wrapper still works. Interactive window should have forced a restart
        await interactiveWindow.addCode('a=1\na', 'foo', 0);
        verifyHtmlOnCell(wrapper, '<span>1</span>', CellPosition.Last);

    }, () => { return ioc; });

    runMountedTest('Preview', async (wrapper) => {

        const testFile = path.join(srcDirectory(), 'sub', 'test.ipynb');

        // Preview is much fewer renders than an add code since the data is already there.
        await getCellResults(wrapper, 2, async () => {
            const interactiveWindow = await getOrCreateInteractiveWindow();
            await interactiveWindow.previewNotebook(testFile);
        });

        verifyHtmlOnCell(wrapper, '<img', CellPosition.Last);
    }, () => { return ioc; });

    runMountedTest('LiveLossPlot', async (wrapper) => {
        // Only run this test when not mocking. Too complicated to mimic otherwise
        if (!ioc.mockJupyter) {
            // Load all of our cells
            const testFile = path.join(srcDirectory(), 'liveloss.py');
            const version = 1;
            const inputText = await fs.readFile(testFile, 'utf-8');
            const document = createDocument(inputText, testFile, version, TypeMoq.Times.atLeastOnce(), true);
            const cells = generateCellsFromDocument(document.object);
            assert.ok(cells, 'No cells generated');
            assert.equal(cells.length, 2, 'Not enough cells generated');

            // Run the first cell
            await addCode(getOrCreateInteractiveWindow, wrapper, concatMultilineString(cells[0].data.source), 4);

            // Last cell should generate a series of updates. Verify we end up with a single image
            await addCode(getOrCreateInteractiveWindow, wrapper, concatMultilineString(cells[1].data.source), 10);
            const cell = getLastOutputCell(wrapper);

            const output = cell!.find('div.cell-output');
            assert.ok(output.length > 0, 'No output cell found');
            const outHtml = output.html();

            const root = parse(outHtml) as any;
            const svgs = root.querySelectorAll('svg') as HTMLElement[];
            assert.ok(svgs, 'No svgs found');
            assert.equal(svgs.length, 1, 'Wrong number of svgs');
        }

    }, () => { return ioc; });

    runMountedTest('Copy back to source', async (_wrapper) => {
        ioc.addDocument(`#%%${os.EOL}print("bar")`, 'foo.py');
        const docManager = ioc.get<IDocumentManager>(IDocumentManager);
        docManager.showTextDocument(docManager.textDocuments[0]);
        const window = await getOrCreateInteractiveWindow() as InteractiveWindow;
        window.copyCode({source: 'print("baz")'});
        assert.equal(docManager.textDocuments[0].getText(), `#%%${os.EOL}print("baz")${os.EOL}#%%${os.EOL}print("bar")`, 'Text not inserted');
        const activeEditor = docManager.activeTextEditor as MockEditor;
        activeEditor.selection = new Selection(1, 2, 1, 2);
        window.copyCode({source: 'print("baz")'});
        assert.equal(docManager.textDocuments[0].getText(), `#%%${os.EOL}#%%${os.EOL}print("baz")${os.EOL}#%%${os.EOL}print("baz")${os.EOL}#%%${os.EOL}print("bar")`, 'Text not inserted');
    }, () => { return ioc; });

    runMountedTest('Limit text output', async (wrapper) => {
        ioc.getSettings().datascience.textOutputLimit = 7;

        // Output should be trimmed to just two lines of output
        const code = `print("hello\\nworld\\nhow\\nare\\nyou")`;
        addMockData(ioc, code, 'are\nyou');
        await addCode(getOrCreateInteractiveWindow, wrapper, code, 4);

        verifyHtmlOnCell(wrapper, '>are\nyou<', CellPosition.Last);
    }, () => { return ioc; });
});
