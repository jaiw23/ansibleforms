'use strict';
const logger=require("../lib/logger");
const mysql=require("./db.model")

//group object create
var Group=function(group){
    this.name = group.name;
};
Group.create = function (record) {
    logger.info(`Creating group ${record.name}`)
    return mysql.do("INSERT INTO AnsibleForms.`groups` set ?", record)
            .then((res)=>{ return res.insertId })
};
Group.update = function (record,id) {
    logger.info(`Updating group ${record.name}`)
    return mysql.do("UPDATE AnsibleForms.`groups` set ? WHERE name=?", [record,id])
};
Group.delete = function(id, result){
    if(id==1){
      logger.warning("Someone is trying to remove the admins group !")
      return new Promise.reject("You cannot delete group 'admins'")
    }else{
      logger.info(`Deleting group ${id}`)
      return mysql.do("DELETE FROM AnsibleForms.`groups` WHERE id = ? AND name<>'admins'", [id])
    }

};
Group.findAll = function (result) {
    logger.info("Finding all groups")
    return mysql.do("SELECT * FROM AnsibleForms.`groups`")
};
Group.findById = function (id) {
    logger.info(`Finding group ${id}`)
    return mysql.do("SELECT * FROM AnsibleForms.`groups` WHERE id=?;",id)
};
Group.findByName = function (name) {
    logger.info(`Finding group ${name}`)
    return mysql.do("SELECT * FROM AnsibleForms.`groups` WHERE name=?;",name)
};

module.exports= Group;
