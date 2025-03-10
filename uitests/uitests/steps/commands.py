# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.


import behave

import uitests.vscode.quick_open


@behave.given('the command "{command}" is selected')
def given_command_selected(context, command):
    """Select a command from the command palette.

    Parameters:
    command (string): Command to be selected

    """
    uitests.vscode.quick_open.select_command(context, command)


@behave.when('I select the command "{command}"')
def when_select_command(context, command):
    """Select a command from the command palette.

    Parameters:
    command (string): Command to be selected

    """
    uitests.vscode.quick_open.select_command(context, command)


@behave.then('select the command "{command}"')
def then_select_command(context, command):
    """Select a command from the command palette.

    Parameters:
    command (string): Command to be selected

    """
    uitests.vscode.quick_open.select_command(context, command)
