/*
 * Copyright 2018 IBM Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Docs for the plugin - total four commands
 *
 */
module.exports = {
    overall:  `<div>This plugin lets you run actions in a local Docker container for testing and debugging purposes. <br/>It requires Docker to be pre-installed in your machine.<br/><br/></div>`,
    invoke: '<div><b>local invoke <i>action_name_or_activation_id</i> [-p name value]</b>: Run an action or activation locally. When replaying an activation, the plugin will fetch its previous activation (if available) to get the input data. You can also provide the input data with -p. Return the output and execution time.</div>',
    debug: '<div><b>local debug <i>action_name_or_activation_id</i> [-p name value]</b>: **Only for NodeJs** Run an action or activation locally, and open Chrome DevTool in the sidecar for live debugging. Return the output.</div>',
    init: '<div><b>local init <i>action_name</i></b>: Start a Docker container with the runtime image of an action (but not yet execute the action). This command is mostly used internally by Shell.</div>',
    kill: `<div><b>local kill container</b>: Kill and remove the Docker container this plugin uses. This command is mostly used internally by Shell. The container is removed automatically when you exit Shell.</div>`
}
