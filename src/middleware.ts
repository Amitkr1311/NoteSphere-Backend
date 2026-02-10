import type { NextFunction, Request,Response } from "express";
import jwt from "jsonwebtoken"
import { JWT_PASSWORD } from "./jwt_password.ts";

export const userMiddleware = (req:Request, res: Response, next: NextFunction) => {
    const header = req.headers["authorization"];

    if (!header) {
        res.status(401).json({
            message: "Authorization header missing"
        });
        return;
    }

    try {
        const decoded = jwt.verify(header as string, JWT_PASSWORD)
        // decoded is the user_id of the use from the database
        if(decoded) {
            //@ts-ignore
            req.userId = decoded.id;
            next();
        }
        else{
            res.status(403).json({
                message: "You are not logged in"
            })
        }
    } catch (error) {
        res.status(403).json({
            message: "Invalid or expired token"
        });
    }
}