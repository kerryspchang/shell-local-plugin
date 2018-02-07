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

const debug = require('debug')('local plugin')
debug('loading')

const { Docker } = require('node-docker-api'),
      dockerConfig = require('./config'),
      docs = require('./docs'),
      { kindToExtension } = require('./kinds'),
      docker = new Docker(),
      $ = require('jquery'),
      rt = require('requestretry'),        
      fs = require('fs-extra'),
      tmp = require('tmp'),
      extract = require('extract-zip');

debug('modules loaded')

/** log terminal marker in openwhisk */
const MARKER = '&XXX_THE_END_OF_A_WHISK_ACTIVATION_XXX'

const strings = {
    stopDebugger: 'Done Debugging'
}

const dontCreateContainer = "don't create container",
    skipInit = "skip initialization",
    dontShutDownContainer = "don't shut down container",
    htmlIncre = '<div style="-webkit-app-region: no-drag; flex: 1; display: flex"></div>',
    spinnerContent ='<div style="display: flex; flex: 1; justify-content: center; align-items: center; font-size: 1.5em"><div class="replay_output" style="order:2;margin-left: 1rem;"></div><div class="replay_spinner" style="animation: spin 2s linear infinite; font-size: 5em; color: var(--color-support-02);"><i class="fas fa-cog"></i></div></div></div>',
    debuggerURL = 'chrome-devtools://devtools/bundled/inspector.html?experiments=true&v8only=true&ws=0.0.0.0:5858';

const uuidPattern = /^[0-9a-f]{32}$/;

/** common execOptions for all of the commands */
const commandOptions = {
    needsUI: true,
    fullscreen: false, //width: 800, height: 600,
    //clearREPLOnLoad: true,
    noAuthOk: true,
    //placeholder: 'Loading visualization ...'
}

let _container, _containerType, _containerCode, _imageDir, _image;



module.exports = (commandTree, prequire) => {
    const wsk = prequire('/ui/commands/openwhisk-core')
    const handler = local(wsk)
    commandTree.listen('/local', handler, Object.assign({docs: docs.overall}, commandOptions));
    commandTree.listen('/local/invoke', handler, Object.assign({docs: docs.invoke}, commandOptions));
    commandTree.listen('/local/debug', handler, Object.assign({docs: docs.debug}, commandOptions));
    commandTree.listen('/local/init', handler, Object.assign({docs: docs.init}, commandOptions));
    commandTree.listen('/local/kill', handler, Object.assign({docs: docs.kill}, commandOptions));

    if(typeof document === 'undefined' || typeof window === 'undefined') return; 
    
    $(window).on('beforeunload', e => {
        if(_container){
            _container.stop();
            _container.delete({ force: true });
        }        
    });   
}

/**
 * Main command handler routine
 *
 */
const local = wsk => (_a, _b, fullArgv, modules, rawCommandString, _2, argvWithoutOptions, dashOptions) => {    
    const { ui } = modules

    return new Promise((resolve, reject) => {  
        if(argvWithoutOptions[0] && argvWithoutOptions[0] != 'local'){
            argvWithoutOptions.unshift('local');
        }
        if(argvWithoutOptions.length === 1){            
            resolve(printDocs());
        }
        else if(Object.keys(docs).indexOf(argvWithoutOptions[1]) < 1){
            // missing wil be -1, 'overall' will be 0. so none of that
            resolve(printDocs());
        }
        else if(argvWithoutOptions.length === 2){
            resolve(printDocs(argvWithoutOptions[1]));
        }       
        else{
            let input = {};
            for(var i=2; i<fullArgv.length; i++){
                let addIndex = 0;
                if(fullArgv[i] === '-p' && fullArgv[i+1] && fullArgv[i+1] != '-p'){
                    addIndex++;
                    if(fullArgv[i+2] && fullArgv[i+2] != '-p'){
                        input[fullArgv[i+1]] = fullArgv[i+2];
                        addIndex++;
                    }
                }
                i += addIndex;
            }

            const returnDiv = $(htmlIncre),
                  spinnerDiv = $(returnDiv).append(spinnerContent)

            // determine bottom bar modes based on the command
            let modes = []

            if(argvWithoutOptions[1] === 'invoke'){ 
                let d

                // when the local activation started
                const start = Date.now()

                Promise.all([getActionNameAndInputFromActivations(argvWithoutOptions[2], spinnerDiv),
                             getImageDir(spinnerDiv)])
                    .then(([data]) => data)
                    .then(updateSidecarHeader('local invoke'))
                    .then(data => {d = data; return getActionCode(data.name, spinnerDiv)})   // data: code, kind, binary
                    .then(data => {d = Object.assign({}, d, data)})
                    .then(() => init(d.kind, spinnerDiv))
                    .then(() => runActionInDocker(d.code, d.kind, Object.assign({}, d.param, d.input, input), d.binary, spinnerDiv))  
                    .then(res => displayAsActivation('local activation', d, start, wsk, res))
                    .catch(e => appendIncreContent(ui.oopsMessage(e), spinnerDiv, 'error'))
            }
            else if(argvWithoutOptions[1] === 'debug'){
                let d

                // when the debug session started
                const start = Date.now()

                modes.push({ mode: 'stop-debugger', label: strings.stopDebugger, actAsButton: true,
                             direct: stopDebugger })

                Promise.all([getActionNameAndInputFromActivations(argvWithoutOptions[2], spinnerDiv),
                             getImageDir(spinnerDiv)])
                .then(([data]) => data)
                .then(updateSidecarHeader('debugger'))
                .then(data => {d = data; return getActionCode(data.name, spinnerDiv)})  // data: {code, kind}
                .then(data => {
                    if(data.kind.indexOf('node') === -1){
                        // not a node action - return
                        return Promise.reject('Currently, debugging support is limited to nodejs actions');
                    }
                    else{
                        data.kind = "nodejs:8";    // debugger only works for nodejs:8
                        d = Object.assign({}, d, data);
                        return init(d.kind, spinnerDiv);
                    }
                    
                })
                .then(() => runActionDebugger(d.name, d.code, d.kind, Object.assign({}, d.param, d.input, input), d.binary, modules, spinnerDiv, returnDiv, dashOptions))
                .then(res => displayAsActivation('debug session', d, start, wsk, res))
                .then(closeDebuggerUI)
                .then(() => debug('debug session done', result))
                .catch(e => appendIncreContent(ui.oopsMessage(e), spinnerDiv, 'error'))
            }
            else if(argvWithoutOptions[1] === 'init'){                
                getImageDir(spinnerDiv)
                .then(() => init(spinnerDiv))
                .then(() => {
                    appendIncreContent('Done', spinnerDiv)
                    removeSpinner(returnDiv);
                })
                .catch(e => {
                    appendIncreContent(e, spinnerDiv, 'error')
                    removeSpinner(returnDiv)
                });
            }
            else if(argvWithoutOptions[1] === 'kill'){
                appendIncreContent('Stopping and removing the container', spinnerDiv);
                kill(returnDiv)
                .then(() => {
                    appendIncreContent('Done', spinnerDiv)
                    removeSpinner(returnDiv);
                })
                .catch(e => {
                    appendIncreContent(e, spinnerDiv, 'error')
                    removeSpinner(returnDiv)
                });
            }

            resolve({
                type: 'custom',
                content: returnDiv[0],
                modes
            })
        }

    });
} /* end of local */

/**
 * Call the OpenWhisk API to retrieve the list of docker base
 * images. The result will be cached in the _imageDir variable.
 *
 */
const getImageDir = spinnerDiv => {
    if(_imageDir !== undefined) {
        // we have cached it
        return Promise.resolve(_imageDir)
    } else {
        // we haven't cached it, yet
        debug('get image locations')

        return repl.qexec('host get')
            .then(data => {
                if(data.indexOf('http') != 0){
                    data = 'https://'+data;
                }

                debug('get image locations:remote call')
                return rt({
                    method: 'get',
                    rejectUnauthorized: false, // TODO we need to pull this from `wsk`
                    url : data,    
                    json: true
                });
            })
            .then(data => _imageDir = data.body.runtimes)
    }
}

/**
 * Kill the current local docker container
 *
 */
const kill = spinnerDiv => {
    return new Promise((resolve, reject) => {
        debug('stopping the container');        
        if(_container){
            // if in this session there's a container started, remove it. 
            _container.stop()
            .then(() => _container.delete({ force: true }))
            .then(() => resolve(true))
            .catch((e => reject(e)));
        }
        else{
            // if no docker container currently recorded, we still try to kill and remove the container, in case shell crashed and left a container opened            

            let rm = false;
            repl.qexec('! docker kill shell-local')
            .then(() => {
                rm = true;  // remove is what matters. cannot open two containers with the same name
                return repl.qexec('! docker rm shell-local');
            })
            .then(() => {
                resolve(true);
            })
            .catch((e) => {
                if(!rm){
                    // if kill failed, try removing the container here again. 
                    repl.qexec('! docker rm shell-local')
                    .then(() => resolve(true))
                    .catch((e) => reject(e));
                }
                else
                    reject(e);
            });
        }                
    });
}

/**
 * Initialize a local docker container
 *
 */
const init = (kind, spinnerDiv) => {
    appendIncreContent('Starting local container', spinnerDiv);

    return new Promise((resolve, reject) => {

        new Promise((resolve, reject) => {   

            debug('init', _containerType, kind, _container)         
            
            if(_container && (_containerType && _containerType === kind)){
                // only in one condition that we will reuse a container, is in the same shell session the same kind of action being invoked 
                debug('reusing the current container');
                resolve(dontCreateContainer);
            }
            else{
                debug('stopping the container');
                // for all other cases, stop and delete the container, reopen a new one
                kill(spinnerDiv)
                .then(d => resolve(d))
                .catch(e => resolve(e));                

                // continue to the next phase no matter what: 
                // if there's any error, it will be catched when starting a container
                // delay here is small enough that it can be ignored 
            }            
        })
        .then(d => {
            if(d === dontCreateContainer){
                return Promise.resolve(d);
            }
            else{                 
                return repl.qexec('! docker image ls');
               

                //let Image = 'openwhisk/action-nodejs-v8';   // need to use kind here to get the right image
                //appendIncreContent('Starting container', spinnerDiv);
                //return docker.container.create(Object.assign({Image: image}, dockerConfig))
            }            
        }) 
        .then(d => {
            if(d === dontCreateContainer){
                return Promise.resolve(d);
            }
            else{
                let image = 'openwhisk/action-nodejs-v8';
                if(_imageDir){
                    Object.keys(_imageDir).forEach(key => {
                        _imageDir[key].forEach(o => {
                            if(o.kind === kind){
                                image = o.image;
                            }
                        });
                    });
                }

                debug('using image', image)

                const imageLabel = image.indexOf(':latest') != -1 ? image.substring(0, image.indexOf(':latest')) : image;
                
                if($(d).html().indexOf(imageLabel) != -1){
                    debug('Image already exist. No need to pull');
                    return Promise.all([Promise.resolve(image)]);
                }
                else{
                    appendIncreContent(`Pulling ${kind} runtime docker image (one-time init)`, spinnerDiv);
                    return Promise.all([Promise.resolve(image), repl.qexec(`! docker pull ${image}`)]);
                }
            }
        })   
        .then(d => {
            if(!Array.isArray(d)){
                return Promise.resolve(d);
            }
            else{                
                return docker.container.create(Object.assign({Image: d[0]}, dockerConfig))
            }
        })             
        .then(d => {
            if(d === dontCreateContainer){
                return Promise.resolve(_container);
            }
            else{
                _container = d; 
                _containerType = kind;            
                return _container.start(); 
            }
        })
        .then(setupLogs)
        .then(() => resolve(true))
        .catch((e => reject(e)));
    });
}

/**
 * Given an activation id, determine the action name and (if possible)
 * input data for that activation.
 *
 */
const getActionNameAndInputFromActivations = (actId, spinnerDiv) => {
    if(!actId.trim().match(uuidPattern)) {
        // then actId is really an action name, so there's nothing to do here
        return Promise.resolve({name: actId, input: {}});
    }

    appendIncreContent('Retrieving activations', spinnerDiv);
    return new Promise((resolve, reject) => {
        repl.qexec(`wsk activation get ${actId}`)
        .then(d => {            
            //appendIncreContent('Retrieving the action code', spinnerDiv); 
            let name = d.name;
            if(d.annotations && Array.isArray(d.annotations)){
                d.annotations.forEach(a => {
                    if(a.key === 'path')
                        name = a.value;
                })
            }           
            return Promise.all([name, d.cause ? repl.qexec(`wsk activation get ${d.cause}`) : undefined ])
        })
        .then(arr => {
            let a = [arr[0]];   
            if(arr.length === 2 && arr[1] !== undefined){
                if(arr[1].logs.indexOf(actId) > 0){
                    // get the previous activation if there's any
                    a.push(repl.qexec(`wsk activation get ${arr[1].logs[arr[1].logs.indexOf(actId)-1]}`))
                }
            }
            return Promise.all(a);
        })
        .then(arr => {          
            resolve({name: arr[0], input: arr[1] ? arr[1].response.result : {}});    
        })
        .catch(e => reject(e));
    });
        
}

/**
 * Fetches the code for a given action
 *
 */
const getActionCode = (actionName, spinnerDiv) => {
    appendIncreContent('Fetching action', spinnerDiv);
    return repl.qexec(`wsk action get ${actionName}`)
        .then(action => {
            let param = {};
            if(action.parameters){
                action.parameters.forEach(a => {param[a.name] = a.value});
            }
            return Object.assign(action.exec, {param: param});
        })
}

/**
 * Returns a DOM that documents this plugin
 *
 */
const printDocs = (name) => {
    if(name && docs[name]){
        return $(docs[name])[0];
    }
    else{
        let s = $("<div></div>");
        Object.keys(docs).forEach(name => {
            //s += (docs[name] + '\n');
            $(s).append($(docs[name]));
        })
        $(s).children().css('white-space', 'pre-wrap').css('margin-bottom', '5px')
        return $(s)[0];
    }
}

/**
 * Fetch logs from the current container
 *
 */
const setupLogs = container => {
    debug('setup logs')

    const { skip=0 } = container
    container.skip += 2 // two end markers per invoke

    if (!container.logger) {
        container.logger = container.logs({
            follow: true,
            stdout: true,
            stderr: true
        })
            .then(stream => {
                stream.on('data', info => {
                    const lines = info.toString().replace(/\n$/,'').split(/\n/) // remove trailing newline
                    let soFar = 0

                    const first = lines.indexOf(_ => _.indexOf(MARKER) >= 0),
                          slicey = first >= 0 && lines.length > 2 ? slicey + 1 : 0

                    lines.slice(slicey).forEach(line => {
                        if (line.indexOf(MARKER) >= 0) {
                            //if (soFar++ >= skip) {
                                // oh great, we found the end marker, which means we're done!
                                debug('logs are done', container.logLines)
                                container.logLineResolve(container.logLines)
                        //}
                        } else /*if (soFar >= skip)*/ {
                            // then we haven't reached the end marker, yet
                            debug('log line', line)
                            container.logLines.push(logLine('stdout', line))
                        }
                    })
                })
                stream.on('error', err => container.logLines.push(logLine('stderr', err)))
            }).catch(container.logLineReject)
    }

    container.logLinesP = new Promise((resolve, reject) => {
        container.logLines = []
        container.logLineResolve = resolve
        container.logLineReject = reject
    })
}

/**
 * Use the bits established by setupLogs to create a { result, logs } structure
 *
 */
const fetchLogs = container => result => {
    debug('fetch logs')
    if (container.logLinesP) {
        return container.logLinesP
            .then(logs => ({ result, logs }))
            .catch(err => {
                // something bad happened collecting the logs
                console.error(err)
                return { result, logs: [] }
            })
    } else {
        return { result, logs: [] }
    }
}

/**
 * Run the given code in a local docker container. We use the /init
 * and /run REST API offered by the container. If the /init call has
 * already been made, e.g. for repeated local invocations of the same
 * action, we can avoid calling /init again.
 *
 */
const runActionInDocker = (functionCode, functionKind, functionInput, isBinary, spinnerDiv) => {
    let start, init, run, end;
    return new Promise((resolve, reject) => {
        let p;
        if(_container && _containerCode === functionCode &&  _containerType === functionKind){
            p = Promise.resolve(skipInit);
        } 
        else{
            //console.log(_container);
            appendIncreContent('Initializing the action', spinnerDiv);
            start = Date.now();
            p = rt({
                method: 'post',
                url : 'http://localhost:8080/' + 'init',
                agentOptions : {
                    rejectUnauthorized : false
                },
                headers : {
                'Content-Type' : 'application/json',
                },
                json : {
                    value: {
                        code: functionCode,
                        main: 'main',
                        binary: isBinary ? isBinary : false
                    }
                }
            })
        }
        
        p.then(() => {
            _containerCode = functionCode;
            init = Date.now();
            appendIncreContent('Running the action', spinnerDiv);
            run = Date.now();
            return rt({
                method: 'post',
                url: 'http://localhost:8080/' + 'run',
                agentOptions : {
                    rejectUnauthorized: false
                },
                headers: {
                    'Content-Type' : 'application/json',
                },
                json: {
                    value: functionInput
                }
            })
        })
        .then(fetchLogs(_container))
        .then(({ result, logs }) => {
            resolve({
                init_time: start ? init-start : undefined,
                result: result.body, logs
            })
        })        
        .catch(error => {          
            if(_container && _container.stop && _container.delete){
                console.error(error);
                kill(spinnerDiv).then(() => {
                    //appendIncreContent('Done', spinnerDiv);
                    reject(error);
                }).catch(e => reject(e));                                   
            }                
            else{
                console.error(error);
                reject(error);
            }
            
        });
    });
}

const debugCodeWrapper = (code, input, path) => {
    return `\n\n${code}\n\n//below is the debuger code added by Shell \n\nlet debugMainFunc = exports.main ? exports.main : main; \nlet s = debugMainFunc(${JSON.stringify(input)});\nrequire('fs').writeFileSync('${path}', JSON.stringify(s))\n`;

}

/**
 * Run the given code inside a local debugging session
 *
 */
const runActionDebugger = (actionName, functionCode, functionKind, functionInput, isBinary, { ui }, spinnerDiv, returnDiv, dashOptions) => new Promise((resolve, reject) => {
    appendIncreContent('Preparing debugger', spinnerDiv)

    // this specifies a path inside docker container, so we should not
    // need to worry about hard-coding something here
    const resultFilePath = '/tmp/debug-session.out';

    // we need to amend the functionCode with a prolog that writes the
    // result somewhere we can find
    let fileCode, entry;
    if(isBinary){
        fileCode = functionCode;
    }
    else{
        fileCode = debugCodeWrapper(functionCode, functionInput, resultFilePath);
    }

    // note that we use the action's name (e.g. myAction.js) as the
    // file name, so that it appears nicely in call stacks and other
    // line numbery displays in the debugger
    let debugFileName;  
    if(isBinary){
        debugFileName = actionName+'.zip';  // for zip actions, use .zip as the extension name
    }
    else {   
        debugFileName = actionName.substring(actionName.lastIndexOf('/') + 1)
          + (kindToExtension[functionKind.replace(/:.*$/,'')] || '');
    }

    //
    // write out our function code, copy it into the docker container,
    // then spawn the debugger, and finally wait for the debug session
    // to complete; at that point, we resolve with { result, logs }
    //

    createTempFolder()
    .then(d => {  // create a local temp folder
        let dirPath = d.path, cleanupCallback = d.cleanupCallback, containerFolderPath = dirPath.substring(dirPath.lastIndexOf('/')+1), entry;        
        fs.outputFile(`${dirPath}/${debugFileName}`, fileCode, isBinary?'base64':undefined) // write file to that local temp folder
        .then(() => {     
            return new Promise((resolve, reject) => {                
                if(isBinary){   // if it is a zip action, unzip first
                    extract(`${dirPath}/${debugFileName}`, {dir: `${dirPath}`}, function (err) {
                        if(err){
                            reject(err);
                        }
                        else{                            
                            fs.readFile(`${dirPath}/package.json`)  // read package.json
                            .then(data => {                            
                                entry = JSON.parse(data).main;
                                return fs.readFile(`${dirPath}/${entry}`);  // get the entry js file
                            })
                            .then(data => {
                                let newCode = debugCodeWrapper(data.toString(), functionInput, resultFilePath); // wrap that js file with our runnner code
                                return fs.outputFile(`${dirPath}/${entry}`, newCode);   // write the new file to temp directory
                            })
                            .then(() => {resolve(entry)})  
                        }                   
                    });
                }
                else {
                    entry = debugFileName;
                    resolve(true);
                }
            });  
        })
        .then(() => repl.qexec(`! docker cp ${dirPath} shell-local:/nodejsAction`)) // copy temp dir into container
        .then(() => appendIncreContent('Starting the debugger', spinnerDiv))         // status update
        .then(() => {
            // this is where we launch the local debugger, and wait for it to terminate
            // as to why we need to hack for the Waiting for debugger on stderr:
            // https://bugs.chromium.org/p/chromium/issues/detail?id=706916
            const logLines = []
            repl.qexec(`! docker exec shell-local node --inspect-brk=0.0.0.0:5858 ${containerFolderPath}/${entry}`, undefined, undefined,
                       { stdout: line => logLines.push(logLine('stdout', line)),
                         stderr: line => {
                           if (line.indexOf('Waiting for the debugger to disconnect') >= 0) {
                               repl.qexec(`! docker cp shell-local:${resultFilePath} ${dirPath}/debug-session.out`)
                                   .then(() => fs.readFile(`${dirPath}/debug-session.out`))
                                   .then(result => JSON.parse(result.toString()))
                                   .then(result => { cleanupCallback(); return result; }) // clean up tmpPath
                                   .then(result => resolve({ result,
                                                             logs: logLines }))
                           } else if (line.indexOf('Debugger listening on') >= 0) {
                               // squash
                           } else if (line.indexOf('For help see https://nodejs.org/en/docs/inspector') >= 0) {
                               // squash
                           } else if (line.indexOf('Debugger attached') >= 0) {
                               // squash
                           } else {
                               // otherwise, hopefully this is a legit application log line
                               logLines.push(logLine('stderr', line))
                           }
                       } }).catch(reject)
        })
        // now, we fetch the URL exported by the local debugger
        // and use this URL to open a webview container around it
        .then(() => rt({ method: 'get', url: 'http://0.0.0.0:5858/json', json: true}))   // fetch url...
        .then(data => {
            // here, we extract the relevant bits of the URL from the response
            if(data && data.body && data.body.length > 0 && data.body[0].devtoolsFrontendUrl) {
                return data.body[0].devtoolsFrontendUrl.substring(data.body[0].devtoolsFrontendUrl.lastIndexOf('/'));
            }
        })
        .then(backtag => {
            // and make webview container from it!
            if (backtag) {
                // remove the spinnery bits
                ui.removeAllDomChildren(returnDiv[0])

                // create and attach the webview
                const webview = $(`<div id="debuggerDiv" style="flex: 1; display: flex"><webview style="flex:1" src="${debuggerURL}${backtag}" autosize="on"></webview></div>`);
                $(returnDiv).append(webview)

                // avoid the repl capturing mouse clicks
                $(webview).mouseup(e => {e.stopPropagation();})
            }
        })
    })
})

/**
 * Add a status message
 *
 */
const appendIncreContent = (content, div, error) => {
    if(div === undefined){
        console.error('Error: content div undefined. content='+content);
        return;
    }

    if(error){
        errorSpinner(div)

        let message = content;
        if(content.error){
            if(content.message)
                message = content.message;
            else
                message = JSON.stringify(content, null, 4);
        }        

        $(div).find('.replay_output').append(`<div class='red-text fake-in'>${message}</div>`);
    }
    else if(typeof content === 'string') {
        $(div).find('.replay_output').append(`<div style='padding-top:0.25ex' class='fade-in'>${content}</div>`);
    } else if(content.response){
         $(div).find('.replay_output').append(`<div><span style="white-space:pre;" class='fade-in'>${JSON.stringify(content, null, 4)}<span></div>`);
    }
    else{        
        $(div).find('.replay_output').append(content);
    }

}

/**
 * Remove the appendIncreContent dom bits, i.e. the status messages
 *
 */
const removeSpinner = div => {
    $(div).children('.replay_spinner').remove();
}

/**
 * Display an error icon in place of the spinner icon
 *
 */
const errorSpinner = spinnerDiv => {
    const iconContainer = $(spinnerDiv).find('.replay_spinner')
    $(iconContainer).css('animation', '')
    $(iconContainer).css('color', '')
    $(iconContainer).addClass('red-text')
    $(iconContainer).empty()
    $(iconContainer).append('<i class="fas fa-exclamation-triangle"></i>')
}

/**
 * Update the sidecar header to reflect the given viewName and entity
 * name stored in data.
 *
 */
const updateSidecarHeader = viewName => data => {
    const { name } = data,
          split = name.split('/'),
          packageName = split.length > 3 ? split[2] : undefined,
          actionName = split[split.length - 1],
          onclick = () => repl.pexec(`action get ${name}`)

    ui.addNameToSidecarHeader(undefined, actionName, packageName, onclick, viewName)

    data.actionName = actionName
    data.packageName = packageName

    return data
}

/**
 * @return a timestamp compatible with OpenWhisk logs
 *
 */
const timestamp = (date=new Date()) => date.toISOString()

/**
 * Make an OpenWhisk-compatible log line
 *
 */
const logLine = (type, line) => `${timestamp()} stdout: ${line.toString()}`

/**
 * Write the given string to a temp file
 *
 * @return {tmpPath, cleanupCallback}
 *
 */
const writeToTempFile = string => new Promise((resolve, reject) => {
    tmp.file((err, tmpPath, fd, cleanupCallback) => {
        if (err) {
            console.error(res.err)
            reject('Internal Error')
        } else {
            return fs.outputFile(tmpPath, string).then(() => resolve({tmpPath, cleanupCallback}))
        }
    })
})


const createTempFolder = () => new Promise((resolve, reject) => {
    tmp.dir({unsafeCleanup: true}, function _tempDirCreated(err, path, cleanupCallback) {
        if (err) {
            console.error(err)
            reject('Internal Error')
        }
        else{
            resolve({path: path, cleanupCallback: cleanupCallback});
        }
      //console.log('Dir: ', path);
     
    });
});
/**
*
*
*/
const displayAsActivation = (sessionType, { kind, actionName, name }, start, { activationModes }, {result, logs, init_time}) => {
    try {
        // when the session ended
        const end = Date.now()

        const annotations = [ { key: 'path', value: `${namespace.current()}/${name}` },
                              { key: 'kind', value: kind }]

        if (init_time) {
            // fake up an initTime annotation
            annotations.push({ key: 'initTime', value: init_time })
        }

        // fake up an activation record and show it
        ui.showEntity(activationModes({ type: 'activations',
                                        activationId: sessionType,  // e.g. "debug session"
                                        name: actionName,
                                        annotations,
                                        statusCode: 0,     // FIXME
                                        start, end,
                                        duration: end - start,
                                        logs,
                                        response: {
                                            success: true, // FIXME
                                            result
                                        }
                                      }))
    } catch (err) {
        console.error(err)
    }
}

/**
 * Clean up the debugger UI
 *
 */
const closeDebuggerUI = ({closeSidecar=false}={}) => {
    $('#debuggerDiv').remove()
}

/**
 * Clean up the debugger UI and close the sidecar
*
*/
const stopDebugger = () => {
    closeDebuggerUI()
    ui.clearSelection()
}

debug('loading done')
