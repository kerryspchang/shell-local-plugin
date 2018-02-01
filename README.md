# shell-local-plugin
An IBM Cloud Functions Shell plugin that lets users run and debug actions in a local docker container. It requires Docker to be pre-installed in your machine. 

Install (if you are in the Shell app, remove `fsh`): 
```
[fsh] plugin install shell-local-plugin
```

After installing the plugin, enter 
```
[fsh] local
```
to see usage. 

The plugin might need to download the Docker image for your action runtime the first time you use it. This takes about 20 seconds but is a one-time thing.

The plugin will start a container when it is first called, and close the container when you exist Shell. 

## Commands

### local play
Run an action or activation in a local docker container. Provide input with `-p`. Return the output data and execution time. 
```
local play action_name_or_activation_id [-p name value]
```

### local debug (currently nodejs only)
Run an action or activation in a local docker container, and open Chrome DevTool for live debugging. Provide input with `-p`. Return the output data. 
```
local debug action_name_or_activation_id [-p name value]
```

