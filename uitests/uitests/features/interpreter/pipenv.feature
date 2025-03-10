# @terminal @terminal.pipenv
# @https://github.com/DonJayamanne/vscode-python-uitests/terminal/execution
# Feature: Terminal (pipenv)
#     Scenario: Interpreter display name contains the name of the current workspace folder and pipenv
#         Given the user setting "python.pythonPath" does not exist
#         And a pipenv environment is created
#         When I reload VSC
#         And I select the Python Interpreter containing the name "workspace folder pipenv"
#         Then the python interpreter displayed in the the status bar contains the value "pipenv" in the display name
#         And the python interpreter displayed in the the status bar contains the value "workspace folder" in the display name
#         And the workspace setting "python.pythonPath" exists

#     @preserve.workspace
#     Scenario: Pipenv is auto selected
#         Given the workspace setting "python.pythonPath" does not exist
#         And the user setting "python.pythonPath" does not exist
#         When I reload VSC
#         Then the python interpreter displayed in the the status bar contains the value "pipenv" in the display name
#         And the python interpreter displayed in the the status bar contains the value "workspace folder" in the display name
#         And the workspace setting "python.pythonPath" exists

#     @preserve.workspace
#     Scenario: Pipenv is not auto selected (if we already have a local interpreter selected)
#         Given a generic Python Interpreter is selected
#         When I reload VSC
#         Then the python interpreter displayed in the the status bar does not contain the value "pipenv" in the display name
#         And the python interpreter displayed in the the status bar does not contain the value "workspace folder" in the display name
#         And the workspace setting "python.pythonPath" exists

#     @preserve.workspace
#     Scenario: Pipenv is not auto selected (if we have a global interpreter selected)
#         Given the workspace setting "python.pythonPath" does not exist
#         And the user setting "python.pythonPath" exists
#         When I reload VSC
#         Then open the file "settings.json"
#         Then the python interpreter displayed in the the status bar does not contain the value "pipenv" in the display name
#         And the python interpreter displayed in the the status bar does not contain the value "workspace folder" in the display name

#     @preserve.workspace
#     Scenario: Environment is not activated in the Terminal
#         Given the workspace setting "python.pythonPath" does not exist
#         And the user setting "python.pythonPath" does not exist
#         When I reload VSC
#         Then the python interpreter displayed in the the status bar contains the value "pipenv" in the display name
#         And the python interpreter displayed in the the status bar contains the value "workspace folder" in the display name
#         Given the file "write_pyPath_in_log.py" is open
#         And a file named "log.log" does not exist
#         And the workspace setting "python.terminal.activateEnvironment" is disabled
#         And a terminal is opened
#         When I send the command "python run_in_terminal.py" to the terminal
#         Then a file named "log.log" will be created
#         And open the file "log.log"
#         And the file "log.log" does not contain the value "workspace_folder"
#         And take a screenshot

#     @preserve.workspace
#     Scenario: Environment is activated in the Terminal
#         Given the workspace setting "python.pythonPath" does not exist
#         And the user setting "python.pythonPath" does not exist
#         When I reload VSC
#         Then the python interpreter displayed in the the status bar contains the value "pipenv" in the display name
#         And the python interpreter displayed in the the status bar contains the value "workspace folder" in the display name
#         Given the file "run_in_terminal.py" is open
#         And a file named "log.log" does not exist
#         And the workspace setting "python.terminal.activateEnvironment" is enabled
#         And a terminal is opened
#         When I send the command "python run_in_terminal.py" to the terminal
#         Then a file named "log.log" will be created
#         And open the file "log.log"
#         And the file "log.log" contains the value "workspace_folder"
#         And take a screenshot
