var Hapi = require('hapi')
  , Joi = require('joi')
  , xmlrpc = require('xmlrpc')
  , ini = require('ini')
  , fs = require('fs')
  , path = require('path');

var config = ini.parse(fs.readFileSync(path.resolve(__dirname, './config.ini'), 'utf-8'));
console.log("Reading config:");
console.log(config);

var erp_host = config.openerp.host
  , erp_port = config.openerp.port
  , erp_db = config.openerp.database
  , erp_user = config.openerp.user
  , erp_password = config.openerp.password
  , pos_pricelist = config.openerp.pos_pricelist
  , couchDb = config.couchdb_log.db
  , couchHost = config.couchdb_log.host
  , couchPort = config.couchdb_log.port || 5984
  , couchUser = config.couchdb_log.user
  , couchPass = config.couchdb_log.password
  , hapier_port = config.hapier.port
  , erp_uid = false
  , employee_fields = ['name', 'id', 'state', 'category_ids', 'login']
  , partner_fields = ['id', 'name', 'contact_address', 'email', 'phone']
  , product_fields = ['id', 'name', 'active', 'list_price'];

// First, we'll connect to the 'common' endpoint to log in to OpenERP
var client_common = xmlrpc.createClient({ host: erp_host, port: erp_port, path: '/xmlrpc/common'});

client_common.methodCall('login', [erp_db, erp_user, erp_password], function (error, value) {
    if (error) { console.log(error); }
    else {
        console.log('Connected to OpenERP as user #' + erp_user);
        erp_uid = value;
    }
});

// Second, once we're logged in, we'll create a connection to access actual objects (employees/volunteers, timesheets, sales, etc.)
var client = xmlrpc.createClient({ host: erp_host, port: erp_port, path: '/xmlrpc/object'});

// Finally, we'll configure our API server
console.log('Starting hapier on port ' + hapier_port);
var server = Hapi.createServer('0.0.0.0', hapier_port, {
  'cors': true
  // ,'json': {'space': 2}
});

var openerpRead = function (model, recordIds, fields, next) {
    client.methodCall('execute', [erp_db, erp_uid, erp_password, model, 'read', recordIds, fields], function (error, data) {
        //console.log(data);
        next(data);
    });
};

server.method('erpRead', openerpRead);

var openerpReadAll = function (model, fields, next) {
    client.methodCall('execute', [erp_db, erp_uid, erp_password, model, 'search', ''], function (error, recordIds) {
        console.log(error);
        server.methods.erpRead(model, recordIds, fields, function (data) {
            next(data);
        });
    });
};

server.method('erpReadAll', openerpReadAll);

function getEmployees(request, reply) {
    server.methods.erpReadAll('hr.employee', employee_fields, function (data) {
        reply(data);
    });

}

function getTimesheets(request, reply) {
    server.methods.erpReadAll('hr_timesheet_sheet.sheet', [], function (data) {
        reply(data);
    });
}

function getEmployee(request, reply) {
    server.methods.erpRead('hr.employee', [request.params.id], employee_fields, function (data) {
        reply(data);
    });
}

function getEmployeeCategories(request, reply) {
  server.methods.erpReadAll('hr.employee.category', [], function (data) {
      reply(data);
  });
}

var getCurrentTimesheet = function (employeeId, departmentId, next) {
    var today = new Date();
    var today_str = [today.getFullYear(), today.getMonth() + 1, today.getDate()].join('-');
    // We'll search to see if there's already a timesheet for today for the specified employee
    var search_args = [['employee_id', '=', employeeId], ['date_from', '=', today_str]];
    console.log(search_args);
    client.methodCall('execute', [erp_db, erp_uid, erp_password, 'hr_timesheet_sheet.sheet', 'search', search_args], function (error, recordIds) {
        console.log(error);
        // If there's already a timesheet, return that timesheet's ID
        if (recordIds.length > 0) {
          server.methods.erpRead('hr_timesheet_sheet.sheet', [recordIds[0]], '', function (data) {
            next(data[0]);
          });
        // Otherwise, create a new timesheet for the specified employee ID for today's date, then return the new timesheet's ID
        } else {
            var newTimesheet = new Object({});
            newTimesheet.date_from = today_str;
            newTimesheet.date_to = today_str;
            newTimesheet.employee_id = employeeId;
            newTimesheet.department_id = departmentId;
            client.methodCall('execute', [erp_db, erp_uid, erp_password, 'hr_timesheet_sheet.sheet', 'create', newTimesheet], function (error, recordId) {
                console.log(error);
                server.methods.erpRead('hr_timesheet_sheet.sheet', recordId, '', function (data) {
                  next(data);
                });
            });
        }
    });
};

function createEmployee(request, reply) {
    console.log(request.payload);
    var fullName = [request.payload.firstName, request.payload.lastName].join(' ');
    var newUser = new Object({});
    if (!request.payload.email) {
      var userName = [request.payload.firstName, request.payload.lastName].join('.').toLowerCase();
      console.log(userName);
      newUser.login = userName;
    } else {
      newUser.login = request.payload.email;
    }
    newUser.email = request.payload.email;
    newUser.name = fullName;
    client.methodCall('execute', [erp_db, erp_uid, erp_password, 'res.users', 'create', newUser], function (error, userID) {
        console.log(error);
        console.log(userID);
        server.methods.erpRead('res.users', userID, '', function (data) {
          console.log(data);
          var newEmployee = new Object({});
          newEmployee.name = data.name;
          newEmployee.work_email = data.email;
          newEmployee.work_phone = request.payload.phone;
          newEmployee.user_id = data.id;
          client.methodCall('execute', [erp_db, erp_uid, erp_password, 'hr.employee', 'create', newEmployee], function (error, employeeID) {
              console.log(error);
              server.methods.erpRead('hr.employee', employeeID, employee_fields, function (data) {
                console.log(data);
                reply(data);
              });
          });
        });
    });

}

function signInEmployee(request, reply) {
    var employeeId = Number(request.payload.employeeId);
    var departmentId = Number(request.payload.departmentId);
    var currentTimesheet = getCurrentTimesheet(employeeId, departmentId, function (sheet) {
        /*
        Once we get the timesheet ID, we need to create an hr.attendance object with the following fields:
        sheet_id: the timesheet ID from getCurrentTimesheet
        employee_id: the supplied employeeId
        action: 'sign_in'
        day: Year-Month-Day (e.g. '2014-01-23')
        name: Year-Month-Day Hour:Minute:Second (e.g. '2014-01-23 12:34:56')
        */
        console.log(sheet);
        var newAttendance = new Object({});
        newAttendance.sheet_id = sheet.id;
        newAttendance.day = sheet.date_from;
        newAttendance.employee_id = employeeId;
        newAttendance.action = 'sign_in';
        console.log(newAttendance);
        client.methodCall('execute', [erp_db, erp_uid, erp_password, 'hr.attendance', 'create', newAttendance], function (error, recordId) {
                console.log(error);
                server.methods.erpRead('hr.addendance', recordId, '', function (data) {
                  reply(data);
                });
        });
    });
}

function signOutEmployee(request, reply) {
    var employeeId = Number(request.payload.employeeId);
    var currentTimesheet = getCurrentTimesheet(employeeId, null, function (sheet) {
        /*
        Once we get the timesheet ID, we need to create an hr.attendance object with the following fields:
        sheet_id: the timesheet ID from getCurrentTimesheet
        employee_id: the supplied employeeId
        action: 'sign_out'
        day: Year-Month-Day (e.g. '2014-01-23')
        name: Year-Month-Day Hour:Minute:Second (e.g. '2014-01-23 12:34:56')
        */
        console.log(sheet);
        var newAttendance = new Object({});
        newAttendance.sheet_id = sheet.id;
        newAttendance.day = sheet.date_from;
        newAttendance.employee_id = employeeId;
        newAttendance.action = 'sign_out';
        console.log(newAttendance);
        client.methodCall('execute', [erp_db, erp_uid, erp_password, 'hr.attendance', 'create', newAttendance], function (error, recordId) {
                console.log(error);
                server.methods.erpRead('hr.addendance', recordId, '', function (data) {
                  reply(data);
                });
        });
    });
}

function getEmployeeAttendance(request, reply) {
    var employeeId = Number(request.params.id);
    var attendance_ids = [];
    var response = new Object({});
    console.log(employeeId);
    var search_args = [['employee_id', '=', employeeId]];
    //var search_args = '';
    console.log(search_args);
    client.methodCall('execute', [erp_db, erp_uid, erp_password, 'hr_timesheet_sheet.sheet', 'search', search_args], function (error, recordIds) {
        console.log(error);
        // If there's already a timesheet, return that timesheet's ID
        console.log(recordIds);
        server.methods.erpRead('hr_timesheet_sheet.sheet', recordIds, '', function (data) {
            response.timesheets = data;
            for (var i in data) {
                attendance_ids = attendance_ids.concat(data[i].attendances_ids);
                console.log(attendance_ids);
            }
            server.methods.erpRead('hr.attendance', attendance_ids, '', function (data) {
                console.log(data);
                response.attendances = data;
                reply(response);
            });

        });
    });
}

function getCompanies(request, reply) {
    server.methods.erpReadAll('res.company', [], function (data) {
        reply(data);
    });
}

function getDepartments(request, reply) {
    server.methods.erpReadAll('hr.department', [], function (data) {
        reply(data);
    });
}

function getProducts(request, reply) {
  server.methods.erpReadAll('product.product', product_fields, function (data) {
        reply(data);
  });
}

function getPartners(request, reply) {
  server.methods.erpReadAll('res.partner', partner_fields, function (data) {
      reply(data);
  });
}

function getSales(request, reply) {
  server.methods.erpReadAll('sale.order', '', function (data) {
      reply(data);
  });
}

function getSale(request, reply) {
  server.methods.erpRead('sale.order', [request.params.id], '', function (data) {
    reply(data);
  });
}

function createSale(request, reply) {
  console.log(request.payload);
  var newSale = new Object({});
  var order = request.payload;
  console.log(order);
  newSale.partner_id = order.partner_id;
  newSale.partner_invoice_id = order.partner_id;
  newSale.partner_shipping_id = order.partner_id;
  newSale.pricelist_id = pos_pricelist;
  console.log(newSale);
  client.methodCall('execute', [erp_db, erp_uid, erp_password, 'sale.order', 'create', newSale], function (error, recordId) {
          console.log(error);
          console.log(recordId);
          server.methods.erpRead('sale.order', recordId, '', function (data) {
            reply(data);
          });
  });
}

function getSaleLines(request, reply) {
  console.log(request.params.id);
  var search_args = [['order_id', '=', Number(request.params.id)]];
  console.log(search_args);
  client.methodCall('execute', [erp_db, erp_uid, erp_password, 'sale.order.line', 'search', search_args], function (error, recordIds) {
    console.log(error);
    console.log(recordIds);
    server.methods.erpRead('sale.order.line', recordIds, '', function (data) {
      reply(data);
    });
  });
}

function createSaleLine(request, reply) {
  // Required fields: order_id, product_id, name (how product appears on order/invoice), price_unit (price per item - defaults to 0), product_uom_qty	(units sold - defaults to 1)
  console.log(request.payload);
  newLine = new Object(request.payload);
  newLine.order_id = request.params.id;
  console.log(newLine);
  client.methodCall('execute', [erp_db, erp_uid, erp_password, 'sale.order.line', 'create', newLine], function (error, recordId) {
    server.methods.erpRead('sale.order.line', recordId, '', function (data) {
      reply(data);
    });
  });
}

//
// Route configuration.
// ---
//

var routes = [
    { path: '/employees', method: 'GET', config: {handler: getEmployees} },
    { path: '/employees/categories', method: 'GET', config: {handler: getEmployeeCategories} },
    { path: '/employees', method: 'POST', config: {
        handler: createEmployee,
        validate: {
            payload: {
                firstName: Joi.string().required(),
                lastName: Joi.string().required(),
                email: Joi.string().email().optional(),
                phone: Joi.string().optional()
            }
        }
    }},
    { path: '/employees/{id}', method: 'GET', config: {handler: getEmployee} },
    { path: '/employees/{id}/attendance', method: 'GET', config: {handler: getEmployeeAttendance} },
    { path: '/employees/sign_in', method: 'POST', config: {
        handler: signInEmployee,
        validate: {
            payload: {
                employeeId: Joi.number().integer(),
                departmentId: Joi.number().integer()
            }
        }
    }},
    { path: '/employees/sign_out', method: 'POST', config: {
        handler: signOutEmployee,
        validate: {
            payload: {
                employeeId: Joi.number().integer()
            }
        }
    }},
    { path: '/timesheets', method: 'GET', config: {handler: getTimesheets} },
    { path: '/companies', method: 'GET', config: {handler: getCompanies} },
    { path: '/products', method: 'GET', config: {handler: getProducts} },
    { path: '/partners', method: 'GET', config: {handler: getPartners} },
    { path: '/sales', method: 'GET', config: {handler: getSales} },
    { path: '/sales', method: 'POST', config: {handler: createSale} },
    { path: '/sales/{id}', method: 'GET', config: {handler: getSale} },
    { path: '/sales/{id}/lines', method: 'GET', config: {handler: getSaleLines} },
    { path: '/sales/{id}/lines', method: 'POST', config: {
      handler: createSaleLine,
      validate: {
        payload: {
          product_id: Joi.number().integer().required(),
          name: Joi.string().required(),
          product_uom_qty: Joi.number(),
          price_unit: Joi.number()
        }
      }
    }},
    { path: '/departments', method: 'GET', config: {handler: getDepartments } }
];

server.route(routes);

if (couchUser && couchPass) {
  var couchUrl = "http://" + couchUser + ":" + couchPass + "@" + couchHost + ":" + couchPort  + "/" + couchDb + "/";
} else {
  var couchUrl = "http://" + couchHost + ":" + couchPort  + "/" + couchDb + "/";
}

var logOptions = {
  maxLogSize: 1024 * 1024 * 10,
  schemaName: 'hapier',
    subscribers: {
        'console':    ['ops', 'request', 'log', 'error'],
        '/tmp/logs/': ['ops', 'request', 'log', 'error']
    }
};

logOptions.subscribers[couchUrl] = ['ops','request','log','error'];

server.pack.register({
    plugin: require('good'),
    options: logOptions
}, function (err) {
   if (err) {
      console.log(err);
      return;
   }
});

server.pack.register({ plugin: require('lout') }, function() {
    server.start();
});
