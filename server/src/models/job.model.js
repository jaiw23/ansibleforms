'use strict';
const https=require('https')
const axios=require('axios')
const fs=require('fs')
const path=require('path')
const YAML = require('yaml')
const moment= require('moment')
const {exec} = require('child_process');
const Helpers = require('../lib/common.js')
const Settings = require('./settings.model')
const logger=require("../lib/logger");
const authConfig = require('../../config/auth.config')
const appConfig = require('../../config/app.config')
const dbConfig = require('../../config/db.config')
const ansibleConfig = require('./../../config/ansible.config');
const mysql = require('./db.model')
const RestResult = require('./restResult.model')
const Form = require('./form.model')
const Credential = require('./credential.model');
const { getAuthorization } = require('./awx.model');
const inspect = require('util').inspect;

const httpsAgent = new https.Agent({
  rejectUnauthorized: false
})
function getHttpsAgent(awxConfig){
  // logger.debug("config : " + awxConfig)
  return new https.Agent({
    rejectUnauthorized: !awxConfig.ignore_certs,
    ca: awxConfig.ca_bundle
  })
}
function delay(t, v) {
    return new Promise(resolve => setTimeout(resolve, t, v));
}
// function replaceSinglePlaceholder(s,ev){
//   var m = s.match(/^\$\(([^\)]+)\)$/)
//   if(m){
//     try{
//       var v =  eval("ev."+m[1])
//       logger.notice(`Succesfully replaced placeholder ${s} => ${v}`)
//       return v

//     }catch(e){
//       logger.error("Error replacing placeholder "+s)
//       return s
//     }
//   }else{
//     return s
//   }
// }

var Exec = function(){}
// start a command with db output
Exec.executeCommand = (cmd,jobid,counter) => {
  // a counter to order the output (as it's very fast and the database can mess up the order)
  var jobstatus = "success"
  var command = cmd.command
  var directory = cmd.directory
  var description = cmd.description
  var extravars = cmd.extravars
  var extravarsFileName = cmd.extravarsFileName
  var keepExtravars = cmd.keepExtravars
  var task = cmd.task
  // execute the procces
  return new Promise((resolve,reject)=>{
    logger.debug(`${description}, ${directory} > ${Helpers.logSafe(command)}`)
    try{
      

      if(extravarsFileName){
        logger.debug(`Storing extravars to file ${extravarsFileName}`)
        var filepath=path.join(directory,extravarsFileName)
        fs.writeFileSync(filepath,extravars) 
      }else{
        logger.warning("No filename was given")
      }

      var child = exec(command,{cwd:directory,encoding: "UTF-8"});

      // add output eventlistener to the process to save output
      child.stdout.on('data',function(data){
        // save the output ; but whilst saving, we quickly check the status to detect abort
        Job.createOutput({output:data,output_type:"stdout",job_id:jobid,order:++counter})
          .then((status)=>{
            // if abort request found ; kill the process
            if(status=="abort"){
              logger.warning("Abort is requested, killing child")
              process.kill(child.pid,"SIGTERM");
            }
          })
          .catch((error)=>{logger.error("Failed to create output : ", error)})
      })
      // add error eventlistener to the process to save output
      child.stderr.on('data',function(data){
        // save the output ; but whilst saving, we quickly check the status to detect abort
        Job.createOutput({output:data,output_type:"stderr",job_id:jobid,order:++counter})
          .then((status)=>{
            // if abort request found ; kill the process
            if(status=="abort"){
              logger.warning("Abort is requested, killing child")
              process.kill(child.pid,"SIGTERM");
            }
          })
          .catch((error)=>{logger.error("Failed to create output: ", error)})
      })
      // add exit eventlistener to the process to handle status update
      child.on('exit',function(data){
        // if the exit was an actual request ; set aborted
        if(child.signalCode=='SIGTERM'){
          Job.endJobStatus(jobid,++counter,"stderr","aborted",`${task} was aborted by operator`)
          reject(`${task} was aborted by operator`)
        }else{ // if the exit was natural; set the jobstatus (either success or failed)
          if(data!=0){
            jobstatus="failed"
            logger.error(`[${jobid}] Failed with code ${data}`)
            Job.endJobStatus(jobid,++counter,"stderr",jobstatus,`[ERROR]: ${task} failed with status (${data})`)
            reject(`${task} failed with status (${data})`)
          }else{
            Job.endJobStatus(jobid,++counter,"stdout",jobstatus,`ok: [${task} finished] with status (${data})`)
            resolve(true)
          }
        }
        if(extravarsFileName && !keepExtravars){
          logger.debug(`Removing extavars file ${filepath}`)
          fs.unlinkSync(filepath)    
        }
             
      })
      // add error eventlistener to the process; set failed
      child.on('error',function(data){
        Job.endJobStatus(jobid,++counter,"stderr","failed",`${task} failed : `+data)
      })

    }catch(e){
      Job.endJobStatus(jobid,++counter,"stderr","failed",`${task} failed : `+e)
      reject()
    }
  })
}
//job stuff... interaction with job database
var Job=function(job){
    if(job.form && job.form!=""){ // first time insert
      this.form = job.form;
      this.target = job.target;
      this.user = job.user;
      this.user_type = job.user_type;
      this.job_type = job.job_type;
      this.start = moment(Date.now()).format('YYYY-MM-DD HH:mm:ss')
      this.extravars = job.extravars;
      this.credentials = job.credentials;
      this.notifications = job.notifications;
    }
    if(job.step && job.step!=""){ // allow single step update
      this.step = job.step
    }
    if(job.status && job.status!=""){ // allow single status update
      this.status = job.status;
    }
    if(job.end && job.end!=""){ // allow single status update
      this.end = job.end;
    }
    if(job.parent_id){
      this.parent_id=job.parent_id
    }
};
Job.create = function (record) {
  // create job
  logger.notice(`Creating job`)
  return mysql.do("INSERT INTO AnsibleForms.`jobs` set ?", record)
    .then((res)=>{ return res.insertId})
};
Job.abandon = function (all=false) {
  // abandon jobs
  logger.notice(`Abandoning jobs`)
  var sql = "UPDATE AnsibleForms.`jobs` set status='abandoned' where (status='running' or status='abort') " // remove all jobs
  if(!all){
    sql = sql + "and (start >= (NOW() - INTERVAL 1 DAY))" // remove jobs that are 1 day old
  }
  return mysql.do(sql)
    .then((res)=>{ return res.changedRows})
};
Job.update = function (record,id) {
  logger.notice(`Updating job ${id} ${record.status}`)
  return mysql.do("UPDATE AnsibleForms.`jobs` set ? WHERE id=?", [record,id])
};
Job.endJobStatus = (jobid,counter,stream,status,message) => {
  // logger.error("------------------------------+++++++++++++++++++++++++++++++----------------------")
  // logger.error(`jobid = ${jobid} ; counter = ${counter} ; status = ${status} ; message = ${message}`)
  // logger.error("------------------------------+++++++++++++++++++++++++++++++----------------------")
  return Job.createOutput({output:message,output_type:stream,job_id:jobid,order:counter})
    .then(()=>{
      return Job.update({status:status,end:moment(Date.now()).format('YYYY-MM-DD HH:mm:ss')},jobid)
        .then(()=>{
           return Job.sendStatusNotification(jobid)
        })
        .catch((error)=>logger.error("Failed to update job : ", error))
    })
    .catch((error)=>{
      logger.error("Failed to create joboutput.", error)
    })
}
Job.printJobOutput = (data,type,jobid,counter,incrementIssue) => {
    if(incrementIssue){
      return Job.deleteOutput({job_id:jobid}).then(()=>{
        return Job.createOutput({output:data,output_type:type,job_id:jobid,order:counter})
      })
    }else{
      return Job.createOutput({output:data,output_type:type,job_id:jobid,order:counter})
    }
    
}
Job.abort = function (id) {
  logger.notice(`Aborting job ${id}`)
  return mysql.do("UPDATE AnsibleForms.`jobs` set status='abort' WHERE id=? AND status='running'", [id])
    .then((res)=>{
      if(res.changedRows==1){
          return res
      }else{
          throw "This job cannot be aborted"
      }
    })
};
Job.deleteOutput = function (record) {
    // delete last output
    return mysql.do("DELETE FROM AnsibleForms.`job_output` WHERE job_id=? ORDER BY `order` DESC LIMIT 1", [record.job_id])
      .then((res)=>{})
};
Job.createOutput = function (record) {
  // logger.debug(`Creating job output`)
  if(record.output){
    // insert output and return status in 1 go
    return mysql.do("SELECT status FROM AnsibleForms.`jobs` WHERE id=?;INSERT INTO AnsibleForms.`job_output` set ?;", [record.job_id,record])
      .then((res)=>{
        if(res.length==2){
          return res[0][0].status
        }else{
          throw "Failed to get job status"
        }
      })
  }else{
    // no output, just return status
    return mysql.do("SELECT status FROM AnsibleForms.`jobs` WHERE id=?;", record.job_id)
      .then((res)=>{ return res[0].status})
  }
};
Job.delete = function(id){
  logger.notice(`Deleting job ${id}`)
  return mysql.do("DELETE FROM AnsibleForms.`jobs` WHERE id = ? OR parent_id = ?", [id,id])
}
Job.findAll = function (user,records) {
    logger.info("Finding all jobs")
    var query
    if(user.roles.includes("admin")){
      query = "SELECT id,form,target,status,start,end,user,user_type,job_type,parent_id,approval FROM AnsibleForms.`jobs` ORDER BY id DESC LIMIT " +records + ";"
    }else{
      query = "SELECT id,form,target,status,start,end,user,user_type,job_type,parent_id,approval FROM AnsibleForms.`jobs` WHERE (user=? AND user_type=?) OR (status='approve') ORDER BY id DESC LIMIT " +records + ";"
    }
    return mysql.do(query,[user.username,user.type])
};
Job.findApprovals = function (user) {
    logger.debug("Finding all approval jobs")
    var count=0
    var query = "SELECT approval FROM AnsibleForms.`jobs` WHERE status='approve' AND approval IS NOT NULL;"
    return mysql.do(query)
    .then((res)=>{
      if(user.roles.includes("admin")){
        return res.length
      }else{
        res.forEach((item, i) => {
          //
          var matches = item.approval.match(/\"roles\":\[([^\]]*)\]/)[1].replaceAll('"','').split(",").filter(x=>user.roles.includes(x))
          if(matches.length>0)count++
        });
        return count
      }
    })
};
Job.findById = function (user,id,asText,logSafe=false) {
    logger.info(`Finding job ${id}` )
    var query
    var params
    if(user.roles.includes("admin")){
      query = "SELECT j.*,sj.subjobs,j2.no_of_records,o.counter FROM AnsibleForms.jobs j LEFT JOIN (SELECT parent_id,GROUP_CONCAT(id separator ',') subjobs FROM AnsibleForms.jobs GROUP BY parent_id) sj ON sj.parent_id=j.id,(SELECT COUNT(id) no_of_records FROM AnsibleForms.jobs)j2,(SELECT max(`order`)+1 counter FROM AnsibleForms.job_output WHERE job_output.job_id=?)o WHERE j.id=?;"
      params = [id,id,user.username,user.type]
    }else{
      query = "SELECT j.*,sj.subjobs,j2.no_of_records,o.counter FROM AnsibleForms.jobs j LEFT JOIN (SELECT parent_id,GROUP_CONCAT(id separator ',') subjobs FROM AnsibleForms.jobs GROUP BY parent_id) sj ON sj.parent_id=j.id,(SELECT COUNT(id) no_of_records FROM AnsibleForms.jobs WHERE user=? AND user_type=?)j2,(SELECT max(`order`)+1 counter FROM AnsibleForms.job_output WHERE job_output.job_id=?)o WHERE j.id=? AND ((j.user=? AND j.user_type=?) OR (j.status='approve'));"
      params = [user.username,user.type,id,id,user.username,user.type]
    }
    // get normal data
    return mysql.do(query,params)
      .then((res)=>{
        if(res.length!=1){
            throw `Job ${id} not found, or access denied`
        }
        var job = res[0]
        // mask passwords
        if(logSafe) job.extravars=Helpers.logSafe(job.extravars)
        // get output summary
        return mysql.do("SELECT COALESCE(output,'') output,COALESCE(`timestamp`,'') `timestamp`,COALESCE(output_type,'stdout') output_type FROM AnsibleForms.`job_output` WHERE job_id=? ORDER by job_output.order;",id)
          .then((res)=>{
            return [{...job,...{output:Helpers.formatOutput(res,asText)}}]
          })
      })
      .catch((err)=>{
        logger.error("Error : ", err)
        return []
      })
};
Job.launch = function(form,formObj,user,creds,extravars,parentId=null,next) {
  if(!formObj){
    // we load it, it's an actual form
    formObj = Form.loadByName(form,user)
    if(!formObj){
      throw "No such form or access denied"
    }
  }
  // console.log(formObj)
  // we have form and we have access
  var notifications=formObj.notifications || {}
  var jobtype=formObj.type
  var target=formObj.name
  var awxStepCredentials=formObj.awxCredentials || []
  if(!target){
    throw "Invalid form or step info"
  }
  // create a new job in the database
  // if reuseId is passed, we don't create a new job and continue the existing one (for approve)
  logger.notice(`Launching form ${form}`)
  return Job.create(new Job({form:form,target:target,user:user.username,user_type:user.type,status:"running",job_type:jobtype,parent_id:parentId,extravars:JSON.stringify(extravars),credentials:JSON.stringify(creds),notifications:JSON.stringify(notifications)}))
    .then(async (jobid)=>{

      logger.debug(`Job id ${jobid} is created`)
      // job created - return to client
      if(next)next({id:jobid})
      // the rest is now happening in the background
      // if credentials are requested, we now get them.
      var credentials={}
      var awxCredentials=[]
      if(creds){
        for (const [key, value] of Object.entries(creds)) {
          if(value=="__self__"){
            credentials[key]={
              host:dbConfig.host,
              user:dbConfig.user,
              port:dbConfig.port,
              password:dbConfig.password
            }
          }else{
            // logger.notice(`found cred for key ${key}`)
            if(key.includes("awx___")){
              // logger.notice(`it is for awx`)
              var credFieldName=key.replace("awx___","")
              // logger.notice(`fieldname = ${credFieldName}`)
              // logger.notice(`awxStepCredentials = ${awxStepCredentials}`)
              if(awxStepCredentials.includes(credFieldName)){
                awxCredentials.push(value)
              }
            }else{
              try{
                credentials[key]=await Credential.findByName(value)
              }catch(err){
                logger.error("Cannot get credential." + err)
              }
            }

          }
        }
      }

      if(jobtype=="ansible"){
        return Ansible.launch(
          formObj.playbook,
          extravars,
          formObj.inventory,
          formObj.tags,
          formObj.limit,          
          formObj.check,
          formObj.diff,
          formObj.verbose,
          formObj.keepExtravars,
          credentials,
          jobid,
          null,
          (parentId)?null:formObj.approval // if multistep: no individual approvals checks
        )
      }
      if(jobtype=="awx"){
        return Awx.launch(
          formObj.template,
          extravars,
          formObj.inventory,
          formObj.tags,
          formObj.limit,
          formObj.check,
          formObj.diff,
          formObj.verbose,
          credentials,
          awxCredentials,
          jobid,
          null,
          (parentId)?null:formObj.approval, // if multistep: no individual approvals checks,
          null,
          notifications
        )
      }
      if(jobtype=="git"){
        Git.push(
          formObj.repo,
          extravars,
          jobid,
          null,
          (parentId)?null:formObj.approval // if multistep: no individual approvals checks
        )
      }
      if(jobtype=="multistep"){
        Multistep.launch(
          form,
          formObj.steps,
          user,
          extravars,
          creds,
          jobid,
          null,
          formObj.approval
        )
      }

    })
    .catch((err)=>{
      logger.error("Failed to create job : ", err)
      return Promise.resolve(err)
    })
};
Job.continue = function(form,user,creds,extravars,jobid,next) {
  var formObj
  // we load it, it's an actual form
  formObj = Form.loadByName(form,user,true)
  if(!formObj){
    throw "No such form or access denied"
  }

  // console.log(formObj)
  // we have form and we have access
  var jobtype=formObj.type
  var target
  if(jobtype=="ansible"){
    target=formObj.playbook
  }
  if(jobtype=="awx"){
    target=formObj.template
  }
  if(jobtype=="git"){
    target=formObj?.repo?.file
  }
  if(jobtype=="multistep"){
    target=formObj.name
  }
  if(!target){
    throw "Invalid form or step info"
    return false
  }
  return Job.findById(user,jobid,true)
    .then((res)=>{
      if(res.length>0){
        var step=res[0].step
        var counter=res[0].counter
        return Job.printJobOutput(`changed: [approved by ${user.username}]`,"stdout",jobid,++counter)
          .then(()=>{
            return Job.update({status:"running"},jobid)
              .then(async (res)=>{
                next({id:jobid}) // continue result for feedback

                // the rest is now happening in the background
                // if credentials are requested, we now get them.
                var credentials={}
                var awxCredentials=[]
                if(creds){
                  for (const [key, value] of Object.entries(creds)) {
                    if(value=="__self__"){
                      credentials[key]={
                        host:dbConfig.host,
                        user:dbConfig.user,
                        port:dbConfig.port,
                        password:dbConfig.password
                      }
                    }else{
                      if(key.includes("awx___")){
                          awxCredentials.push(value)
                      }else{
                        try{
                          credentials[key]=await Credential.findByName(value)
                        }catch(err){
                          logger.error("Failed to find credentials by name : ", err)
                        }
                      }

                    }
                  }
                }

                if(jobtype=="ansible"){
                  return Ansible.launch(
                    formObj.playbook,
                    extravars,
                    formObj.inventory,
                    formObj.tags,
                    formObj.limit,
                    formObj.check,
                    formObj.diff,
                    formObj.verbose,
                    formObj.keepExtravars,
                    credentials,
                    jobid,
                    ++counter,
                    formObj.approval,
                    true
                  )
                }
                if(jobtype=="awx"){
                  return Awx.launch(
                    formObj.template,
                    extravars,
                    formObj.inventory,
                    formObj.tags,
                    formObj.limit,
                    formObj.check,
                    formObj.diff,
                    formObj.verbose,
                    credentials,
                    awxCredentials,
                    jobid,
                    ++counter,
                    formObj.approval,
                    true
                  )
                }
                if(jobtype=="git"){
                  Git.push(formObj.repo,extravars,jobid,++counter,formObj.approval,true)
                }
                if(jobtype=="multistep"){
                  Multistep.launch(form,formObj.steps,user,extravars,creds,jobid,++counter,formObj.approval,step,true)
                }
              })
          })
      }else{
        logger.error("No job found with id " + jobid)
      }
    })
};
Job.relaunch = function(user,id,next){
  return Job.findById(user,id,true)
    .then((job)=>{
      if(job.length==1){
        var j=job[0]
        var extravars = {}
        var credentials = {}
        if(j.extravars){
          extravars = JSON.parse(j.extravars)
        }
        if(j.credentials){
          credentials = JSON.parse(j.credentials)
        }
        if(!["running","aborting","abort"].includes(j.status)){
          logger.notice(`Relaunching job ${id} with form ${j.form}`)
          Job.launch(j.form,null,user,credentials,extravars,null,(out)=>{
            next(out)
          })
        }else{
          throw `Job ${id} is not in a status to be relaunched (status=${j.status})`
        }
      }else{
        throw `Job ${id} not found`
      }
    })
}
Job.approve = function(user,id,next){
  return Job.findById(user,id,true)
    .then((job)=>{
      if(job.length==1){
        var j=job[0]
        var approval=JSON.parse(j.approval)
        if(approval){
          var access = approval?.roles.filter(role => user?.roles?.includes(role))
          if(access?.length>0 || user?.roles?.includes("admin")){
            logger.notice(`Approve allowed for user ${user.username}`)
          }else {
            logger.warning(`Approve denied for user ${user.username}`)
            throw `Approve denied for user ${user.username}`
          }
        }
        var extravars = {}
        var credentials = {}
        if(j.extravars){
          extravars = JSON.parse(j.extravars)
        }
        if(j.credentials){
          credentials = JSON.parse(j.credentials)
        }
        if(j.status=="approve"){
          logger.notice(`Approving job ${id} with form ${j.form}`)
          Job.continue(j.form,user,credentials,extravars,id,(job)=>{
             next(job)
          })
          .catch((err)=>{logger.error("Failed to continue the job : ", err)})
        }else{
          throw `Job ${id} is not in approval status (status=${j.status})`
        }
      }else{
        throw `Job ${id} not found`
      }
    })
}
Job.sendApprovalNotification = function(approval,extravars,jobid){
  if(!approval?.notifications?.length>0)return false

  Settings.find()
    .then((config)=>{
      return config.url?.replace(/\/$/g,'') // remove trailing slash if present
    })
    .then((url)=>{
      var subject = Helpers.replacePlaceholders(approval.title,extravars) || "AnsibleForms Approval Request"
      var buffer = fs.readFileSync(`${__dirname}/../templates/approval.html`)
      var message = buffer.toString()
      var color = "#158cba"
      var color2 = "#ffa73b"
      var logo = `${url}/assets/img/logo.png`
      var approvalMessage = Helpers.replacePlaceholders(approval.message,extravars)
      message = message.replace("${message}",approvalMessage)
                      .replaceAll("${url}",url)
                      .replaceAll("${jobid}",jobid)
                      .replaceAll("${title}",subject)
                      .replaceAll("${logo}",logo)
                      .replaceAll("${color}",color)
                      .replaceAll("${color2}",color2)
      return Settings.mailsend(approval.notifications.join(","),subject,message)
    })
    .then((messageid)=>{logger.notice("Approval mail sent to " + approval.notifications.join(",") + " with id " + messageid)})
    .catch((err)=>{logger.error("Failed : ", err)})
}
Job.sendStatusNotification = function(jobid){
  logger.notice(`Sending status mail for jobid ${jobid}`)
  var user={
    roles:["admin"]
  }

  logger.notice(`Finding jobid ${jobid}`)
  Job.findById(user,jobid,false,true)  // first get job
    .then((j)=>{  // if jobs
      if(!j.length==1){
        logger.error(`No job found with jobid ${jobid}`)
        return false
      }
      var job=j[0]
      var notifications=JSON.parse(job.notifications) // get notifications if any
      if(notifications && notifications.on){
        logger.warning("Deprecated property 'on'.  Use 'onStatus' instead.  This property will be removed in future versions.")
      }
      if(notifications && !notifications.on && !notifications.onStatus){
        notifications.onStatus=['any']
      }
      if(!notifications.recipients){
        logger.notice("No notifications set")
        return false
      }else if(!notifications.on?.includes(job.status) && !notifications.on?.includes("any") && !notifications.onStatus?.includes(job.status) && !notifications.onStatus?.includes("any")){
        logger.notice(`Skipping notification for status ${job.status}`)
        return false
      }else{
        // we have notifications, correct status => let's send the mail
        return Settings.find()
          .then((config)=>{
            return config.url?.replace(/\/$/g,'') // remove trailing slash if present
          })
          .then((url)=>{
            if(!url){
              logger.warn(`Host URL is not set, no status mail can be sent. Go to 'settings' to correct this.`)
              return false
            }
            var subject = `AnsibleForms '${job.form}' [${job.job_type}] (${jobid}) - ${job.status} `
            var buffer = fs.readFileSync(`${__dirname}/../templates/jobstatus.html`)
            var message = buffer.toString()
            var color = "#158cba"
            var color2 = "#ffa73b"
            var logo = `${url}/assets/img/logo.png`
            message = message.replace("${message}",job.output.replaceAll("\r\n","<br>"))
                            .replaceAll("${url}",url)
                            .replaceAll("${jobid}",jobid)
                            .replaceAll("${title}",subject)
                            .replaceAll("${logo}",logo)
                            .replaceAll("${color}",color)
                            .replaceAll("${color2}",color2)
            return Settings.mailsend(notifications.recipients.join(","),subject,message)
          })
          .catch((err)=>{logger.error("Failed : ", err)})
      }
    })
    .then((messageid)=>{
      if(!messageid){
        logger.notice("No status mail sent")
      }else{
        logger.notice("Status mail sent with id " + messageid)}
      }
    )
    .catch((err)=>{logger.error("Failed : ", err)})
}
Job.reject = function(user,id){
  return Job.findById(user,id,true)
    .then((job)=>{
      if(job.length==1){
        var j=job[0]
        var approval=JSON.parse(j.approval)
        if(approval){
          var access = approval?.roles.filter(role => user?.roles?.includes(role))
          if(access?.length>0 || user?.roles?.includes("admin")){
            logger.notice(`Reject allowed for user ${user.username}`)
          }else {
            logger.warning(`Reject denied for user ${user.username}`)
            throw `Reject denied for user ${user.username}`
          }
        }
        var counter=j.counter
        if(j.status=="approve"){
          logger.notice(`Rejecting job ${id} with form ${j.form}`)
          return Job.printJobOutput(`changed: [rejected by ${user.username}]`,"stderr",id,++counter)
            .then(()=>{
              return Job.update({status:"rejected",end:moment(Date.now()).format('YYYY-MM-DD HH:mm:ss')},id)
            })
        }else{
          throw `Job ${id} is not in rejectable status (status=${j.status})`
        }
      }else{
        throw `Job ${id} not found`
      }
    })
}
// Multistep stuff
var Multistep = function(){}

Multistep.launch = async function(form,steps,user,extravars,creds,jobid,counter,approval,fromStep,approved=false){
  // create a new job in the database
  if(!counter){
    counter=0
  }else{
    counter++
  }
  // global approval
  if(!fromStep && approval){
    if(!approved){
      Job.sendApprovalNotification(approval,extravars,jobid)
      Job.printJobOutput(`APPROVE [${form}] ${'*'.repeat(69-form.length)}`,"stdout",jobid,++counter)
      return Job.update({status:"approve",approval:JSON.stringify(approval),end:moment(Date.now()).format('YYYY-MM-DD HH:mm:ss')},jobid)
        .then(()=>{return true})
        .catch((error)=>{logger.error("Failed to update job : ", error)})
    }else{
      logger.notice("Continuing multistep " + form + " it has been approved")
      // reset flag for steps
      approved=false
    }
  }
  var ok=0
  var failed=0
  var skipped=0
  var aborted=false
  try{
    var finalSuccessStatus=true  // multistep success from start to end ?
    var partialstatus=false      // was there a step that failed and had continue ?
    var approve=false            // flag to halt at approval
    steps.reduce(     // loop promises of the steps
      async (promise,step)=>{    // we get the promise of the previous step and the new step
        return promise.then(async (previousSuccess) =>{ // we don't actually use previous success
          var result=false
          // HANDLE SKIPPING --------------------------------
          // console.log("fromstep : " + fromStep)
          if(fromStep && fromStep!=step.name){
            // Job.printJobOutput(`STEP [${step.name}] ${'*'.repeat(72-step.name.length)}`,"stdout",jobid,++counter)
            // Job.printJobOutput(`skipped: due to continue`,"stdout",jobid,++counter)
            logger.info("Skipping step " + step.name + " - in continue phase")
            // skipped++
            return true
          }
          // reset from step
          fromStep=undefined
          if(approve && !approved){
            // Job.printJobOutput(`STEP [${step.name}] ${'*'.repeat(72-step.name.length)}`,"stdout",jobid,++counter)
            // Job.printJobOutput(`skipped: due to approval`,"stdout",jobid,++counter)
            logger.info("Skipping step " + step.name + " due to approval")
            // skipped++
            return true
          }
          if(step.ifExtraVar && extravars[step.ifExtraVar]!==true){
            Job.printJobOutput(`STEP [${step.name}] ${'*'.repeat(72-step.name.length)}`,"stdout",jobid,++counter)
            Job.printJobOutput(`skipped: due to condition`,"stdout",jobid,++counter)
            logger.info("Skipping step " + step.name + " due to condition")
            skipped++
            return true
          }
          // ------- SKIPPING HANDLED -----------------------
          logger.notice("Running step " + step.name)
          Job.update({step:step.name,status:"running"},jobid)
            .catch((error)=>{logger.error("Failed to update job", error)})
           // set step in parent
          // if this step has an approval
          if(step.approval){
            if(!approved){
              logger.notice("Approve needed for " + step.name)
              Job.sendApprovalNotification(step.approval,extravars,jobid)
              Job.printJobOutput(`APPROVE [${step.name}] ${'*'.repeat(69-step.name.length)}`,"stdout",jobid,++counter)
              Job.update({status:"approve",approval:JSON.stringify(step.approval),end:moment(Date.now()).format('YYYY-MM-DD HH:mm:ss')},jobid)
                .catch((error)=>{logger.error("Failed to update job", error)})
              approve=true // set approve flag
              return true // complete this step
            }else{
              approved=false // approved is done, reset approved flag
            }
          }
          // print title of new step and check abort
          return Job.printJobOutput(`STEP [${step.name}] ${'*'.repeat(72-step.name.length)}`,"stdout",jobid,++counter)
          .then((status)=>{
            if(status=="abort"){
              aborted=true
            }
            return true // goto to next then
          })
          .then(async ()=>{
            // if aborted is requested, stop the flow
            if(aborted){
                skipped++
                logger.debug("skipping: step " + step.name)
                finalSuccessStatus=false
                Job.printJobOutput("skipping: [Abort is requested]","stdout",jobid,++counter)
                // fail this step
                return false
            } // fail step due to abort
            else{
                // if the previous steps were ok (or failed with continue) OR step has always:true
                if(finalSuccessStatus || step.always){
                    // filter the extravars with "key"
                    var ev = {...extravars}
                    // steps can have a key, we then take a partial piece of the extravars to send to the step
                    if(step.key && ev[step.key]){
                      // logger.warning(step.key + " exists using it")
                      ev = ev[step.key]
                      // we copy the user profile in the step data
                      ev.ansibleforms_user = extravars.ansibleforms_user
                    }
                    // wait the promise of step
                    result= await Job.launch(form,step,user,creds,ev,jobid,function(job){
                        Job.printJobOutput(`ok: [Launched step ${step.name} with jobid '${job.id}']`,"stdout",jobid,++counter)
                    })
                    // in the job promise we return either true or error message
                    if(result!==true){
                      throw result // fail this step
                    }
                    // job was success
                    ok++
                    // exit step and return promise true
                    return true

                }else{ // previous was not success or there was fail in other steps
                  // skip this step
                  skipped++
                  logger.debug("skipping: step " + step.name)
                  finalSuccessStatus=false
                  Job.printJobOutput("skipping: [due to previous failure]","stdout",jobid,++counter)
                  // fail this step
                  return false
                }
            }
          })
        }).catch((err)=>{
          // step failed in promise - something was wrong
          failed++
          logger.error("Failed step " + step.name)
          Job.printJobOutput("[ERROR]: Failed step "+ step.name + " : " + err,"stderr",jobid,++counter)
          // if continue, we mark partial and mark as success
          if(step.continue){
            partialstatus=true
            return true
          }else{  // no continue, we fail the multistep
            finalSuccessStatus=false
            return false
          }
        })
      },
      Promise.resolve(true) // initial reduce promise
    ).catch((err)=>{ // failed at last step
      // we still need to handle the last failure
      failed++
      logger.error("Failed step " + steps[-1].name)
      finalSuccessStatus=false
      Job.printJobOutput("Failed step "+ steps[-1].name + " : " + err,"stderr",jobid,++counter)

    }).then((success)=>{ // last step success
      logger.debug("Last step => " + success)
    }).finally(()=>{ // finally create recap
      // create recap
      if(!approve){
        Job.printJobOutput(`MULTISTEP RECAP ${'*'.repeat(64)}`,"stdout",jobid,++counter)
        Job.printJobOutput(`localhost   : ok=${ok}    failed=${failed}    skipped=${skipped}`,"stdout",jobid,++counter)
        if(finalSuccessStatus){
          // if multistep was success
          if(partialstatus){
            // but a step failed with continue => mark as warning
            Job.endJobStatus(jobid,++counter,"stdout","warning","[WARNING]: Finished multistep with warnings")
          }else{
            // mark as full success
            Job.endJobStatus(jobid,++counter,"stdout","success","ok: [Finished multistep successfully]")
          }

        }else{  // no multistep success
          if(aborted){
            // if aborted mark as such
            Job.endJobStatus(jobid,++counter,"stderr","aborted","multistep was aborted")
          }else{
            // else, mark failed
            Job.endJobStatus(jobid,++counter,"stderr","failed","[ERROR]: Finished multistep with errors")
          }
        }
      }
    })

  }catch(e){
    // a final catch for fatal errors // should not occur if properly coded
    logger.error(e)
    Job.endJobStatus(jobid,++counter,"stderr","failed",e)
  }
}
// Ansible stuff
var Ansible = function(){}
Ansible.launch=(playbook,ev,inv,tags,limit,c,d,v,k,credentials,jobid,counter,approval,approved=false)=>{
  if(!counter){
    counter=0
  }else{
    counter++
  }
  if(approval){
    if(!approved){
      Job.sendApprovalNotification(approval,ev,jobid)
      Job.printJobOutput(`APPROVE [${playbook}] ${'*'.repeat(69-playbook.length)}`,"stdout",jobid,++counter)
      Job.update({status:"approve",approval:JSON.stringify(approval),end:moment(Date.now()).format('YYYY-MM-DD HH:mm:ss')},jobid)
       .catch((error)=>{logger.error("Failed to update job : ", error)})
      return true
    }else{
      logger.notice("Continuing ansible " + playbook + " it has been approved")
    }
  }
  // we make a copy, we don't want to mutate the original
  var extravars={...ev}
  // ansible can have multiple inventories
  var inventory = []
  if(inv){
    inventory.push(inv) // push the main inventory
  }
  if(extravars["__inventory__"]){
      ([].concat(extravars["__inventory__"])).forEach((item, i) => {
        if(typeof item=="string"){
          inventory.push(item) // add extra inventories
        }else{
          logger.warning("Non-string inventory entry")
        }
      });
  }
  
  // playbook could be controlled from extravars
  var pb = extravars?.__playbook__ || playbook
  // tags could be controlled from extravars
  var tgs = extravars?.__tags__ || tags || ""
  // check could be controlled from extravars
  var check = extravars?.__check__ || c || false
  // verbose could be controlled from extravars
  var verbose = extravars?.__verbose__ || v || false  
  // limit could be controlled from extravars
  var lmit = extravars?.__limit__ || limit || ""
  // verbose could be controlled from extravars
  var keepExtravars = extravars?.__keepExtravars__ || k || false    
  // diff could be controlled from extravars
  var diff = extravars?.__diff__ || d || false  
  // merge credentials now
  extravars = {...extravars,...credentials}
  // convert to string for the command
  extravars = JSON.stringify(extravars)
  // make extravars file
  const extravarsFileName = `extravars_${jobid}.json`;
  logger.debug(`Extravars File: ${extravarsFileName}`);
  // prepare my ansible command

  var command = `ansible-playbook -e '@${extravarsFileName}'`
  inventory.forEach((item, i) => {  command += ` -i '${item}'` });
  if(tgs){ command += ` -t '${tgs}'` }
  if(check){ command += ` --check` }
  if(diff){ command += ` --diff` }
  if(verbose){ command += ` -vvv`}
  if(lmit){ command += ` --limit '${lmit}'`}
  command += ` ${pb}`
  var directory = ansibleConfig.path
  var cmdObj = {directory:directory,command:command,description:"Running playbook",task:"Playbook",extravars:extravars,extravarsFileName:extravarsFileName,keepExtravars:keepExtravars}

  logger.notice("Running playbook : " + pb)
  logger.debug("extravars : " + extravars)
  logger.debug("inventory : " + inventory)
  logger.debug("check : " + check)
  logger.debug("diff : " + diff)
  logger.debug("tags : " + tgs)
  logger.debug("limit : " + lmit)
  // in the background, start the commands
  return Exec.executeCommand(cmdObj,jobid,counter)
}

// awx stuff, interaction with awx
var Awx = function(){}
Awx.getConfig = require('./awx.model').getConfig
Awx.getAuthorization= require('./awx.model').getAuthorization
Awx.abortJob = function (id, next) {

  Awx.getConfig()
    .then((awxConfig)=>{

      var message=""
      logger.info(`aborting awx job ${id}`)
      const axiosConfig = getAuthorization(awxConfig)
      // we first need to check if we CAN cancel
      axios.get(awxConfig.uri + "/api/v2/jobs/" + id + "/cancel/",axiosConfig)
        .then((axiosnext)=>{
          var job = axiosnext.data
          if(job && job.can_cancel){
              logger.info(`can cancel job id = ${id}`)
              axios.post(awxConfig.uri + "/api/v2/jobs/" + id + "/cancel/",{},axiosConfig)
                .then((axiosnext)=>{
                  job = axiosnext.data
                  next(null,job)
                })
                .catch(function (error) {
                  logger.error("Failed to abort awx job : ", error)
                  next(`failed to abort awx job ${id}`)
                })
          }else{
              message=`cannot cancel job id ${id}`
              logger.error(message)
              next(message)
          }
        })
        .catch(function (error) {
          logger.error("Failed to abort awx job : ", error)
          next(`failed to abort awx job ${id}`)
        })
      })
      .catch((err)=>{
        logger.error("Failed to get AWX configuration : ", err)
        next(`failed to get AWX configuration`)
      })
};
Awx.launch = function (template,ev,inv,tags,limit,c,d,v,credentials,awxCredentials,jobid,counter,approval,approved=false){
    var message=""
    if(!counter){
      counter=0
    }else{
      counter++
    }
    if(approval){
      if(!approved){
        Job.sendApprovalNotification(approval,ev,jobid)
        Job.printJobOutput(`APPROVE [${template}] ${'*'.repeat(69-template.length)}`,"stdout",jobid,++counter)
        Job.update({status:"approve",approval:JSON.stringify(approval),end:moment(Date.now()).format('YYYY-MM-DD HH:mm:ss')},jobid)
         .catch((error)=>{logger.error("Failed to update job : ", error)})
        return true
      }else{
        logger.notice("Continuing awx " + template + " it has been approved")
      }
    }
    // we make a copy, we don't mutate the original
    var extravars={...ev}

    // awx can have only 1 inventory and could be controlled by extravars
    var invent = extravars?.__inventory__ || inv    
    // playbook could be controlled from extravars
    var tgs = extravars?.__tags__ || tags || ""
    // check could be controlled from extravars
    var check = extravars?.__check__ || c || false
    // verbose could be controlled from extravars
    var verbose = extravars?.__verbose__ || v || false  
    // limit could be controlled from extravars
    var lmit = extravars?.__limit__ || limit || ""
    // diff could be controlled from extravars
    var diff = extravars?.__diff__ || d || false  
    // template could be controlled from extravars
    var templ = extravars?.__template__ || template

    return Awx.findJobTemplateByName(templ)
      .catch((err)=>{
        message="failed to find awx template " + templ + "\n" + err
        Job.endJobStatus(jobid,++counter,"stdout","failed",message)
        throw message
      })
      .then((jobTemplate)=>{
          logger.debug("Found jobtemplate, id = " + jobTemplate.id)
          if(invent){
            return Awx.findInventoryByName(invent)
            .then((inventory)=>{
                logger.debug("Found inventory, id = " + inventory.id)
                return Awx.launchTemplate(jobTemplate,ev,inventory,tgs,lmit,check,diff,verbose,credentials,awxCredentials,jobid,++counter)
            })
            .catch((err)=>{
              message="failed to find inventory " + invent + "\n" + err
              Job.endJobStatus(jobid,++counter,"stdout","failed",message)
              throw message
            })
          }else{
            logger.debug("running without inventory")
            return Awx.launchTemplate(jobTemplate,ev,undefined,tgs,lmit,check,diff,verbose,credentials,awxCredentials,jobid,++counter)
          }
      })

}
Awx.launchTemplate = async function (template,ev,inventory,tags,limit,c,d,v,credentials,awxCredentials,jobid,counter) {
  var message=""
  if(!counter){
    counter=0
  }
  var awxCredentialList=await Awx.findCredentialsByTemplate(template.id)
  logger.notice(`Found ${awxCredentialList.length} existing creds`)
  for(let i=0;i<awxCredentials.length;i++){
    try{
      var ac=awxCredentials[i]
      var credId=await Awx.findCredentialByName(ac)
      logger.debug(`Found awx credential '${ac}'; id = ${credId}`)
      awxCredentialList.push(credId)
    }catch(e){
      logger.error(e.toString())
    }
  }
  awxCredentialList=[...new Set(awxCredentialList)]
  return Awx.getConfig()
  .catch((err)=>{
    logger.error("Failed to get AWX configuration : ", err)
    message= `failed to get AWX configuration`
    Job.endJobStatus(jobid,++counter,"stderr",status,message)
    throw message
  })
  .then((awxConfig)=>{
      var extravars={...ev} // we make a copy of the main extravars
      // merge credentials now
      extravars = {...extravars,...credentials}
      extravars = JSON.stringify(extravars)
      // prep the post data
      var postdata = {
        extra_vars:extravars
      }
      if(awxCredentialList.length>0){
        postdata.credentials=awxCredentialList
      }
      // inventory needs to be looked up first
      if(inventory){ postdata.inventory=inventory.id }
      if(c){ postdata.job_type="check" }
        else{ postdata.job_type="run" }
      if(d){ postdata.diff_mode=true }
        else{ postdata.diff_mode=false }
      if(v) { postdata.verbosity=3}
      if(limit){ postdata.limit=limit}
      if(tags){ postdata.job_tags=tags }

      logger.notice("Running template : " + template.name)
      logger.info("extravars : " + extravars)
      logger.info("inventory : " + inventory)
      logger.info("credentials : " + awxCredentialList)
      logger.info("check : " + c)
      logger.info("diff : " + d)
      logger.info("verbose : " + v)      
      logger.info("tags : " + tags)
      logger.info("limit : " + limit)
      // post
      if(template.related===undefined){
        message=`Failed to launch, no launch attribute found for template ${template.name}`
        logger.error(message)
        Job.endJobStatus(jobid,++counter,"stderr",status,message)
        throw message
      }else{
        // prepare axiosConfig
        const axiosConfig = Awx.getAuthorization(awxConfig)
        logger.debug("Lauching awx with data : " + JSON.stringify(postdata))
        // launch awx job
        return axios.post(awxConfig.uri + template.related.launch,postdata,axiosConfig)
          .catch(function (error) {
            var message=`failed to launch ${template.name}`
            if(error.response){
                logger.error(error.response.data)
                message+="\r\n" + YAML.stringify(error.response.data)
                Job.endJobStatus(jobid,++counter,"stderr","success",`Failed to launch template ${template.name}. ${message}`)
            }else{
                logger.error("Failed to launch : ", error)
                Job.endJobStatus(jobid,++counter,"stderr","success",`Failed to launch template ${template.name}. ${error}`)
            }
            throw message
          })
          .then((axiosresult)=>{
            // get awx job (= remote job !!)
            var job = axiosresult.data
            if(job){
              logger.info(`awx job id = ${job.id}`)
              // log launch
              return Job.printJobOutput(`Launched template ${template.name} with jobid ${job.id}`,"stdout",jobid,++counter)
                .then(()=>{
                  // track the job in the background
                  return Awx.trackJob(job,jobid,++counter)
                })
            }else{
              // no awx job, end failed
              message=`could not launch job template ${template.name}`
              Job.endJobStatus(jobid,counter,"stderr","failed",`Failed to launch template ${template.name}`)
              logger.error(message)
              throw message
            }
          })

      }
  })

};
Awx.trackJob = function (job,jobid,counter,previousoutput,previousoutput2=undefined,lastrun=false,retryCount=0) {
  return Awx.getConfig()
  .catch((err)=>{
    logger.error("Failed to get AWX configuration : ", err)
    failed(`failed to get AWX configuration`,jobid,counter)
    return Promise.resolve(err)
  })
  .then((awxConfig)=>{
      var message=""
      logger.info(`searching for job with id ${job.id}`)
      // prepare axiosConfig
      const axiosConfig = Awx.getAuthorization(awxConfig)
      return axios.get(awxConfig.uri + job.url,axiosConfig)
        .then((axiosresult)=>{
          var j = axiosresult.data;
          if(j){
            // logger.debug(inspect(j))
            logger.debug(`awx job status : ` + j.status)
            return Awx.getJobTextOutput(job)
            .then((o)=>{
                var incrementIssue=false
                var output=o
                // AWX has no incremental output, so we always need to substract previous output
                // we substract the previous output
                if(output && previousoutput){
                    // does the previous output fit in the new
                    if(output.includes(previousoutput)){
                      output = output.substring(previousoutput.length)
                    }else{
                      if(output && previousoutput2){
                        // here we have an output problem, the incremental of AWX can sometime deviate
                        // and the last output was wrong, in this case we remove the last output from the db and take the second last output
                        // as last reference.
                        incrementIssue=true
                        // logger.error("Incremental problem")
                        output = output.substring(previousoutput2.length)
                      }
                    }
                }
                // the increment issue (if true) will remove the last entry before add the new (corrected) one.
                return Job.printJobOutput(output,"stdout",jobid,++counter,incrementIssue)
                .then((dbjobstatus)=>{
                  if(dbjobstatus && dbjobstatus=="abort"){
                    Job.printJobOutput("Abort requested","stderr",jobid,++counter)
                    Job.update({status:"aborting",end:moment(Date.now()).format('YYYY-MM-DD HH:mm:ss')},jobid)
                     .catch((error)=>{logger.error("Failed to update job : ", error)})
                    Awx.abortJob(j.id,(error,res)=>{
                      if(error){
                        Job.endJobStatus(jobid,++counter,"stderr","failed","Abort failed \n"+error)
                      }else{
                        Job.endJobStatus(jobid,++counter,"stderr","aborted","Aborted job")
                      }
                    })
                    return Promise.resolve("Abort requested")
                  }else{
                    if(j.finished && lastrun){
                      if(j.status==="successful"){
                        Job.endJobStatus(jobid,++counter,"stdout","success",`Successfully completed template ${j.name}`)
                        return Promise.resolve(true)
                      }else{
                        // if error, end with status (aborted or failed)
                        var status="failed"
                        var message=`Template ${j.name} completed with status ${j.status}`
                        if(j.status=="canceled"){
                          status="aborted"
                          message=`Template ${j.name} was aborted`
                        }
                        Job.endJobStatus(jobid,++counter,"stderr",status,message)
                        return Promise.resolve(message)
                      }
                    }else{
                      // not finished, try again
                      return delay(1000).then(()=>{
                        if(j.finished){
                          logger.debug("Getting final stdout")
                        }
                        if(incrementIssue){
                          return Awx.trackJob(j,jobid,++counter,o,previousoutput2,j.finished)
                        }
                        return Awx.trackJob(j,jobid,++counter,o,previousoutput,j.finished)
                      })
                    }
                  }
                })
            })
            .catch((err)=>{
              message = err.toString()
              logger.error(message)
              retryCount++
              if(retryCount==10){
                return Promise.resolve(message)
              }else{
                logger.warning(`Retrying jobid ${jobid} [${retryCount}]`)
                return delay(1000).then(()=>{
                  return Awx.trackJob(job,jobid,counter,previousoutput,previousoutput2,lastrun,retryCount)
                })
              }
            })
          }else{
            message=`could not find job with id ${job.id}`
            logger.error(message)
            retryCount++
            if(retryCount==10){
              return Promise.resolve(message)
            }else{
              logger.warning(`Retrying jobid ${jobid} [${retryCount}]`)
              return delay(1000).then(()=>{
                return Awx.trackJob(job,jobid,counter,previousoutput,previousoutput2,lastrun,retryCount)
              })
            }
          }
        })
        .catch(function (error) {
          message=error.message
          logger.error(message)
          return Promise.resolve(message)
        })

  })

};
Awx.getJobTextOutput = function (job) {
  return Awx.getConfig()
  .catch((err)=>{
    logger.error("Failed to get AWX configuration : ", err)
    failed(`failed to get AWX configuration`,jobid,counter)
    return Promise.resolve(err)
  })
  .then((awxConfig)=>{
      var message=""
      if(job.related===undefined){
        throw "No such job"
      }else{
        if(!job.related.stdout){
          // workflow job... just return status
          return job.status
        }
        // prepare axiosConfig
        const axiosConfig = Awx.getAuthorization(awxConfig)
        return axios.get(awxConfig.uri + job.related.stdout + "?format=txt",axiosConfig)
          .then((axiosresult)=>{ 
            return axiosresult.data 
          })

      }
  })
};
Awx.findJobTemplateByName = function (name) {
  return Awx.getConfig()
  .catch((err)=>{
    logger.error("Failed to get AWX configuration : ", err)
    result(`failed to get AWX configuration`)
  })
  .then((awxConfig)=>{
      var message=""
      logger.info(`searching job template ${name}`)
      // prepare axiosConfig
      const axiosConfig = Awx.getAuthorization(awxConfig)
      return axios.get(awxConfig.uri + "/api/v2/job_templates/?name=" + encodeURI(name),axiosConfig)
        .then((axiosresult)=>{
          var job_template = axiosresult.data.results.find(function(jt, index) {
            if(jt.name == name)
              return true;
          });
          if(job_template){
            return job_template
          }else{
            logger.info("Template not found, looking for workflow job template")
            // trying workflow job templates
            return axios.get(awxConfig.uri + "/api/v2/workflow_job_templates/?name=" + encodeURI(name),axiosConfig)
              .then((axiosresult)=>{
                var job_template = axiosresult.data.results.find(function(jt, index) {
                  if(jt.name == name)
                    return true;
                });
                if(job_template){
                  return job_template
                }else{
                  message=`could not find job template ${name}`
                  logger.error(message)
                  throw message
                }
              })
          }
        })
  })
};
Awx.findCredentialByName = function (name) {
  return Awx.getConfig()
  .catch((err)=>{
    logger.error("Failed to get AWX configuration : ", err)
    result(`failed to get AWX configuration`)
    return Promise.resolve(err)
  })
  .then((awxConfig)=>{
      var message=""
      logger.info(`searching credential ${name}`)
      // prepare axiosConfig
      const httpsAgent = new https.Agent({
        rejectUnauthorized: false
      })
      const axiosConfig = Awx.getAuthorization(awxConfig)
      return axios.get(awxConfig.uri + "/api/v2/credentials/?name=" + encodeURI(name),axiosConfig)
        .then((axiosresult)=>{
          var credential = axiosresult.data.results.find(function(jt, index) {
            if(jt.name == name)
              return true;
          });
          if(credential){
            return credential.id
          }else{
            message=`could not find credential ${name}`
            logger.error(message)
            throw message
          }
        })
  })
};
Awx.findCredentialsByTemplate = function (id) {
  return Awx.getConfig()
  .catch((err)=>{
    logger.error("Failed to get AWX configuration : ", err)
    result(`failed to get AWX configuration`)
    return Promise.resolve(err)
  })
  .then((awxConfig)=>{
      var message=""
      logger.info(`searching credentials for template id ${id}`)
      // prepare axiosConfig
      const httpsAgent = new https.Agent({
        rejectUnauthorized: false
      })
      const axiosConfig = Awx.getAuthorization(awxConfig)
      return axios.get(awxConfig.uri + "/api/v2/job_templates/"+id+"/credentials/",axiosConfig)
        .then((axiosresult)=>{
          if(axiosresult.data?.results?.length){
            return axiosresult.data.results.map(x=>x.id)
          }
          return []
        })
        .catch((e)=>{
          return []
        })
  })
};
Awx.findInventoryByName = function (name) {
  return Awx.getConfig()
  .catch((err)=>{
    logger.error("Failed to get AWX configuration : ", err)
    result(`failed to get AWX configuration`)
    return Promise.resolve(err)
  })
  .then((awxConfig)=>{
      var message=""
      logger.info(`searching inventory ${name}`)
      // prepare axiosConfig
      const httpsAgent = new https.Agent({
        rejectUnauthorized: false
      })
      const axiosConfig = Awx.getAuthorization(awxConfig)
      return axios.get(awxConfig.uri + "/api/v2/inventories/?name=" + encodeURI(name),axiosConfig)
        .then((axiosresult)=>{
          var inventory = axiosresult.data.results.find(function(jt, index) {
            if(jt.name == name)
              return true;
          });
          if(inventory){
            return inventory
          }else{
            message=`could not find inventory ${name}`
            logger.error(message)
            throw message
          }
        })
  })
};

// git stuff
var Git=function(){};
Git.push = function (repo,ev,jobid,counter,approval,approved=false) {
    if(!counter){
      counter=0
    }else{
      counter++
    }
    if(approval){
      if(!approved){
        Job.sendApprovalNotification(approval,ev,jobid)
        Job.printJobOutput(`APPROVE [${repo.file}] ${'*'.repeat(69-repo.file.length)}`,"stdout",jobid,++counter)
        Job.update({status:"approve",approval:JSON.stringify(approval),end:moment(Date.now()).format('YYYY-MM-DD HH:mm:ss')},jobid)
         .catch((error)=>{logger.error("Failed to update job : ", error)})
        return true
      }else{
        logger.notice("Continuing awx " + repo.file + " it has been approved")
      }
    }
    // we make a copy to not mutate
    var extravars={...ev}
    try{
      // save the extravars as file - we do this in sync, should be fast
      Job.printJobOutput(`TASK [Writing YAML to local repo] ${'*'.repeat(72-26)}`,"stdout",jobid,++counter)
      var yaml = YAML.stringify(extravars)
      fs.writeFileSync(path.join(appConfig.repoPath,repo.dir,repo.file),yaml)
      // log the save
      Job.printJobOutput(`ok: [Extravars Yaml file created : ${repo.file}]`,"stdout",jobid,++counter)
      Job.printJobOutput(`TASK [Committing changes] ${'*'.repeat(72-18)}`,"stdout",jobid,++counter)
      // start commit
      var command = `git commit --allow-empty -am "update from ansibleforms" && ${repo.push}`
      var directory = path.join(appConfig.repoPath,repo.dir)
      return Exec.executeCommand({directory:directory,command:command,description:"Pushing to git",task:"Git push"},jobid,counter)

    }catch(e){
      logger.error(e)
      Job.endJobStatus(jobid,++counter,"stderr","failed",e)
      return Promise.resolve(e)
    }
};
module.exports= Job;
