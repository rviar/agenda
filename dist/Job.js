"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Job = void 0;
const date = require("date.js");
const debug = require("debug");
const JobParameters_1 = require("./types/JobParameters");
const priority_1 = require("./utils/priority");
const nextRunAt_1 = require("./utils/nextRunAt");
const log = debug('agenda:job');
/**
 * @class
 */
class Job {
    constructor(agenda, args, byJobProcessor = false) {
        var _a;
        this.agenda = agenda;
        this.byJobProcessor = byJobProcessor;
        // Set attrs to args
        this.attrs = {
            ...args,
            // Set defaults if undefined
            priority: (0, priority_1.parsePriority)(args.priority),
            nextRunAt: args.nextRunAt === undefined ? new Date() : args.nextRunAt,
            disabled: (_a = args === null || args === void 0 ? void 0 : args.disabled) !== null && _a !== void 0 ? _a : false,
            type: args.type
        };
    }
    /**
     * Given a job, turn it into an JobParameters object
     */
    toJson() {
        const result = {};
        for (const key of Object.keys(this.attrs)) {
            if (Object.hasOwnProperty.call(this.attrs, key)) {
                result[key] =
                    JobParameters_1.datefields.includes(key) && this.attrs[key]
                        ? new Date(this.attrs[key])
                        : this.attrs[key];
            }
        }
        return result;
    }
    /**
     * Sets a job to repeat every X amount of time
     * @param interval
     * @param options
     */
    repeatEvery(interval, options = {}) {
        this.attrs.repeatInterval = interval;
        this.attrs.repeatTimezone = options.timezone;
        if (options.skipImmediate) {
            // Set the lastRunAt time to the nextRunAt so that the new nextRunAt will be computed in reference to the current value.
            this.attrs.lastRunAt = this.attrs.nextRunAt || new Date();
            this.computeNextRunAt();
            this.attrs.lastRunAt = undefined;
        }
        else {
            this.computeNextRunAt();
        }
        return this;
    }
    /**
     * Sets a job to repeat at a specific time
     * @param time
     */
    repeatAt(time) {
        this.attrs.repeatAt = time;
        return this;
    }
    /**
     * Prevents the job from running
     */
    disable() {
        this.attrs.disabled = true;
        return this;
    }
    /**
     * Allows job to run
     */
    enable() {
        this.attrs.disabled = false;
        return this;
    }
    /**
     * Data to ensure is unique for job to be created
     * @param unique
     * @param opts
     */
    unique(unique, opts) {
        this.attrs.unique = unique;
        this.attrs.uniqueOpts = opts;
        return this;
    }
    /**
     * Schedules a job to run at specified time
     * @param time
     */
    schedule(time) {
        const d = new Date(time);
        this.attrs.nextRunAt = Number.isNaN(d.getTime()) ? date(time) : d;
        return this;
    }
    /**
     * Sets priority of the job
     * @param priority priority of when job should be queued
     */
    priority(priority) {
        this.attrs.priority = (0, priority_1.parsePriority)(priority);
        return this;
    }
    /**
     * Fails the job with a reason (error) specified
     *
     * @param reason
     */
    fail(reason) {
        this.attrs.failReason = reason instanceof Error ? reason.message : reason;
        this.attrs.failCount = (this.attrs.failCount || 0) + 1;
        const now = new Date();
        this.attrs.failedAt = now;
        this.attrs.lastFinishedAt = now;
        log('[%s:%s] fail() called [%d] times so far', this.attrs.name, this.attrs._id, this.attrs.failCount);
        return this;
    }
    async fetchStatus() {
        const dbJob = await this.agenda.db.getJobs({ _id: this.attrs._id });
        if (!dbJob || dbJob.length === 0) {
            // @todo: should we just return false instead? a finished job could have been removed from database,
            // and then this would throw...
            throw new Error(`job with id ${this.attrs._id} not found in database`);
        }
        this.attrs.lastRunAt = dbJob[0].lastRunAt;
        this.attrs.lockedAt = dbJob[0].lockedAt;
        this.attrs.lastFinishedAt = dbJob[0].lastFinishedAt;
    }
    /**
     * A job is running if:
     * (lastRunAt exists AND lastFinishedAt does not exist)
     * OR
     * (lastRunAt exists AND lastFinishedAt exists but the lastRunAt is newer [in time] than lastFinishedAt)
     * @returns Whether or not job is running at the moment (true for running)
     */
    async isRunning() {
        if (!this.byJobProcessor) {
            // we have no job definition, therfore we are not the job processor, but a client call
            // so we get the real state from database
            await this.fetchStatus();
        }
        if (!this.attrs.lastRunAt) {
            return false;
        }
        if (!this.attrs.lastFinishedAt) {
            return true;
        }
        if (this.attrs.lockedAt &&
            this.attrs.lastRunAt.getTime() > this.attrs.lastFinishedAt.getTime()) {
            return true;
        }
        return false;
    }
    /**
     * Saves a job to database
     */
    async save() {
        // ensure db connection is ready
        await this.agenda.ready;
        return this.agenda.db.saveJob(this);
    }
    /**
     * Remove the job from database
     */
    remove() {
        return this.agenda.cancel({ _id: this.attrs._id });
    }
    async isDead() {
        if (!this.byJobProcessor) {
            // we have no job definition, therfore we are not the job processor, but a client call
            // so we get the real state from database
            await this.fetchStatus();
        }
        return this.isExpired();
    }
    isExpired() {
        const definition = this.agenda.definitions[this.attrs.name];
        const lockDeadline = new Date(Date.now() - definition.lockLifetime);
        // This means a job has "expired", as in it has not been "touched" within the lockoutTime
        // Remove from local lock
        if (this.attrs.lockedAt && this.attrs.lockedAt < lockDeadline) {
            return true;
        }
        return false;
    }
    /**
     * Updates "lockedAt" time so the job does not get picked up again
     * @param progress 0 to 100
     */
    async touch(progress) {
        if (this.canceled) {
            throw new Error(`job ${this.attrs.name} got canceled already: ${this.canceled}!`);
        }
        this.attrs.lockedAt = new Date();
        this.attrs.progress = progress;
        await this.agenda.db.saveJobState(this);
    }
    computeNextRunAt() {
        try {
            if (this.attrs.repeatInterval) {
                this.attrs.nextRunAt = (0, nextRunAt_1.computeFromInterval)(this.attrs);
                log('[%s:%s] nextRunAt set to [%s]', this.attrs.name, this.attrs._id, new Date(this.attrs.nextRunAt).toISOString());
            }
            else if (this.attrs.repeatAt) {
                this.attrs.nextRunAt = (0, nextRunAt_1.computeFromRepeatAt)(this.attrs);
                log('[%s:%s] nextRunAt set to [%s]', this.attrs.name, this.attrs._id, this.attrs.nextRunAt.toISOString());
            }
            else {
                this.attrs.nextRunAt = null;
            }
        }
        catch (error) {
            this.attrs.nextRunAt = null;
            this.fail(error);
        }
        return this;
    }
    async run() {
        const definition = this.agenda.definitions[this.attrs.name];
        this.attrs.lastRunAt = new Date();
        log('[%s:%s] setting lastRunAt to: %s', this.attrs.name, this.attrs._id, this.attrs.lastRunAt.toISOString());
        this.computeNextRunAt();
        await this.agenda.db.saveJobState(this);
        try {
            this.agenda.emit('start', this);
            this.agenda.emit(`start:${this.attrs.name}`, this);
            log('[%s:%s] starting job', this.attrs.name, this.attrs._id);
            if (!definition) {
                log('[%s:%s] has no definition, can not run', this.attrs.name, this.attrs._id);
                throw new Error('Undefined job');
            }
            if (definition.fn.length === 2) {
                log('[%s:%s] process function being called', this.attrs.name, this.attrs._id);
                await new Promise((resolve, reject) => {
                    try {
                        const result = definition.fn(this, error => {
                            if (error) {
                                reject(error);
                                return;
                            }
                            resolve();
                        });
                        if (this.isPromise(result)) {
                            result.catch((error) => reject(error));
                        }
                    }
                    catch (error) {
                        reject(error);
                    }
                });
            }
            else {
                log('[%s:%s] process function being called', this.attrs.name, this.attrs._id);
                await definition.fn(this);
            }
            this.attrs.lastFinishedAt = new Date();
            this.agenda.emit('success', this);
            this.agenda.emit(`success:${this.attrs.name}`, this);
            log('[%s:%s] has succeeded', this.attrs.name, this.attrs._id);
        }
        catch (error) {
            log('[%s:%s] unknown error occurred', this.attrs.name, this.attrs._id);
            this.fail(error);
            this.agenda.emit('fail', error, this);
            this.agenda.emit(`fail:${this.attrs.name}`, error, this);
            log('[%s:%s] has failed [%s]', this.attrs.name, this.attrs._id, error.message);
        }
        finally {
            this.attrs.lockedAt = undefined;
            try {
                await this.agenda.db.saveJobState(this);
                log('[%s:%s] was saved successfully to MongoDB', this.attrs.name, this.attrs._id);
            }
            catch (err) {
                // in case this fails, we ignore it
                // this can e.g. happen if the job gets removed during the execution
                log('[%s:%s] was not saved to MongoDB', this.attrs.name, this.attrs._id, err);
            }
            this.agenda.emit('complete', this);
            this.agenda.emit(`complete:${this.attrs.name}`, this);
            log('[%s:%s] job finished at [%s] and was unlocked', this.attrs.name, this.attrs._id, this.attrs.lastFinishedAt);
        }
    }
    isPromise(value) {
        return !!(value && typeof value.then === 'function');
    }
}
exports.Job = Job;
//# sourceMappingURL=Job.js.map